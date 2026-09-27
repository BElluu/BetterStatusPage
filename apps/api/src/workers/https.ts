import type { HttpsConfig } from '@bsp/shared'
import type { MonitorStatus } from '@bsp/shared'
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

    let res: HttpResponse
    if (auth.cas) {
      res = await requestWithCas(config, { ...auth, cas: auth.cas }, opts)
    } else {
      res = await pooledFetch(auth.url, {
        method: config.method ?? 'GET',
        headers: { ...(config.headers ?? {}), ...auth.headers },
        ...(config.body !== undefined ? { body: config.body } : {}),
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

    if (config.keyword) {
      const body = await res.text()
      if (!body.includes(config.keyword)) {
        return {
          status: 'degraded',
          responseMs,
          error: `Keyword "${config.keyword}" not found in response body`,
        }
      }
    } else {
      await discardBody(res)
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
