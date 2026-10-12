import type { HttpsConfig } from '@bsp/shared'
import type { MonitorStatus } from '@bsp/shared'
import { evaluateAssertions, hasJsonAssertions } from './assertions.js'
import { discardBody, requestWithCas, resolveHttpAuth, type HttpFetch, type HttpResponse } from './httpAuth.js'
import { Agent, fetch as httpFetch } from 'undici'
import { lookup as dnsLookup } from 'dns'
import type { LookupFunction } from 'net'

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
// between checks, keeping measured response times accurate.
const httpAgent = new Agent({
  connect: { lookup: cachedLookup },
  keepAliveTimeout: 5 * 60_000,
  keepAliveMaxTimeout: 30 * 60_000,
})

/** Scheduled checks reuse the pooled agent so repeated checks measure the endpoint, not the handshake. */
const pooledFetch: HttpFetch = (url, init) => httpFetch(url, { ...init, dispatcher: httpAgent })

export async function checkHttps(
  config: HttpsConfig,
  timeoutMs: number,
): Promise<{ status: MonitorStatus; responseMs: number | null; error: string | null }> {
  const start = Date.now()
  // One deadline for the whole exchange: token/ticket requests, redirects and reading the body.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs)
  const opts = { fetch: pooledFetch, signal: controller.signal }
  try {
    const auth = await resolveHttpAuth(config.auth, config.url, opts)

    const method = config.method ?? 'GET'
    let res: HttpResponse
    if (auth.cas) {
      res = await requestWithCas(config, { ...auth, cas: auth.cas }, opts)
    } else {
      res = await pooledFetch(auth.url, {
        method,
        headers: { ...(config.headers ?? {}), ...auth.headers },
        ...(config.body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body: config.body } : {}),
        signal: controller.signal,
        redirect: 'follow',
      })
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
    const readBody = (): Promise<string> => (bodyText ??= res.text())
    if (!config.keyword && !hasJsonAssertions(config.assertions)) await discardBody(res)

    // Every failed check is reported; the worst status wins, and a "down" assertion beats a "degraded" one.
    const failures: { status: MonitorStatus; error: string }[] = []
    if (config.keyword && !(await readBody()).includes(config.keyword)) {
      failures.push({ status: 'degraded', error: `Keyword "${config.keyword}" not found in response body` })
    }
    for (const o of await evaluateAssertions(config.assertions ?? [], res.headers, readBody)) {
      if (!o.ok) failures.push({ status: o.onFail, error: o.detail ?? o.label })
    }
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
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 'down', responseMs, error: msg }
  } finally {
    clearTimeout(timer)
  }
}
