import type { HttpsConfig } from '@bsp/shared'
import type { MonitorStatus } from '@bsp/shared'
import { evaluateAssertions, hasJsonAssertions } from './assertions.js'
import { discardBody, followRedirects, insecureForOrigin, requestUrl, readBodyText, requestWithCas, resolveHttpAuth, skipsTlsVerification, type HttpFetch, type HttpResponse } from './httpAuth.js'
import { lookup as dnsLookup } from 'dns'
import type { LookupFunction } from 'net'
import { proxiedFetch, proxyAwareAgent, unwrapRefusal } from '../services/ssrfGuard.js'

// Application-level DNS cache — avoids repeated resolver round-trips between checks.
const dnsCache = new Map<string, { address: string; family: number; expires: number }>()

const cachedLookup: LookupFunction = (hostname, options, callback): void => {
  const family = options.family ?? 0
  const key = `${hostname}:${family}`
  const hit = dnsCache.get(key)
  if (hit && hit.expires > Date.now()) {
    if (options.all) callback(null, [{ address: hit.address, family: hit.family }])
    else callback(null, hit.address, hit.family)
    return
  }
  if (options.all) {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      const resolved = addresses ?? []
      const first = resolved[0]
      if (!err && first) dnsCache.set(key, { ...first, expires: Date.now() + 5 * 60_000 })
      callback(err, resolved)
    })
  } else {
    dnsLookup(hostname, { ...options, all: false }, (err, address, fam) => {
      if (!err && address) dnsCache.set(key, { address, family: fam, expires: Date.now() + 5 * 60_000 })
      callback(err, address, fam)
    })
  }
}

// Persistent connection pool — reuses TCP/TLS connections and caches DNS lookups
// between checks, keeping measured response times accurate. Honours HTTP_PROXY, HTTPS_PROXY and NO_PROXY.
const httpAgent = proxyAwareAgent({ lookup: cachedLookup, keepAlive: true })

// Same pool for monitors that opted out of certificate verification (`ignoreTls`).
const insecureHttpAgent = proxyAwareAgent({ lookup: cachedLookup, rejectUnauthorized: false, keepAlive: true })

/** Scheduled checks reuse the pooled agent so repeated checks measure the endpoint, not the handshake. */
const pooledFetch: HttpFetch = proxiedFetch(httpAgent)
const insecurePooledFetch: HttpFetch = proxiedFetch(insecureHttpAgent)

export async function checkHttps(
  config: HttpsConfig,
  timeoutMs: number,
): Promise<{ status: MonitorStatus; responseMs: number | null; error: string | null }> {
  const start = Date.now()
  // One deadline for the whole exchange: token/ticket requests, redirects and reading the body.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs)
  const fetchWith = skipsTlsVerification(config) ? insecureForOrigin(config.url, pooledFetch, insecurePooledFetch) : pooledFetch
  const opts = { fetch: fetchWith, signal: controller.signal }
  try {
    const auth = await resolveHttpAuth(config.auth, config.url, opts)

    let res: HttpResponse
    if (auth.cas) {
      res = await requestWithCas(config, { ...auth, cas: auth.cas }, opts)
    } else {
      // Redirects are followed by hand: a redirect to another origin is checked with certificate verification and
      // carries no credential headers, which fetch itself would not guarantee.
      res = await followRedirects({ ...config, url: requestUrl(config, auth.url) }, auth.headers, controller.signal, fetchWith)
    }

    const responseMs = Date.now() - start
    const expectedStatus = config.expectedStatus ?? 200

    if (res.status !== expectedStatus) {
      await discardBody(res)
      return {
        status: 'down',
        responseMs,
        error: `Expected HTTP ${expectedStatus}, got ${res.status}`,
      }
    }

    // The body is read once, and only when the keyword or a JSON assertion needs it.
    let bodyText: Promise<string> | undefined
    const readBody = (): Promise<string> => (bodyText ??= readBodyText(res))
    if (!config.keyword && !hasJsonAssertions(config.assertions)) await discardBody(res)

    // Every failed check is reported; the worst status wins, and a "down" assertion beats a "degraded" one.
    const failures: { status: MonitorStatus; error: string }[] = []
    if (config.keyword && !(await readBody()).includes(config.keyword)) {
      failures.push({ status: 'degraded', error: `Keyword "${config.keyword}" not found in response body` })
    }
    for (const o of await evaluateAssertions(config.assertions ?? [], res.headers, readBody)) {
      if (!o.ok) failures.push({ status: o.onFail, error: o.detail ?? o.label })
    }
    // A body no check read (a declared size over the limit skips the read) must not keep its connection open.
    if (!bodyText) await discardBody(res)
    if (config.degradedAboveMs !== undefined && responseMs > config.degradedAboveMs) {
      failures.push({ status: 'degraded', error: `Response took ${responseMs} ms, over the ${config.degradedAboveMs} ms limit` })
    }
    if (failures.length > 0) {
      return {
        status: failures.some((f) => f.status === 'down') ? 'down' : 'degraded',
        responseMs,
        error: failures.map((f) => f.error).join('; '),
      }
    }

    return { status: 'up', responseMs, error: null }
  } catch (err) {
    const responseMs = Date.now() - start
    const reason = unwrapRefusal(err)
    const msg = reason instanceof Error ? reason.message : String(reason)
    return { status: 'down', responseMs, error: msg }
  } finally {
    clearTimeout(timer)
  }
}
