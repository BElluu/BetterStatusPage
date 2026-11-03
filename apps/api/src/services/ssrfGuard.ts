import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { BlockList, isIP, type LookupFunction, type Socket } from 'node:net'
import { Agent, buildConnector, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

/**
 * A monitor, a test or an action connects to whatever address its owner typed in, and shows
 * something of the answer. Private networks are what a self-hosted status page exists to watch, but
 * the metadata services of cloud hosts hand out the instance's credentials to anyone who can reach
 * them, so those addresses are refused. The check runs when the connection is opened, on the
 * address actually used, which also covers redirects and DNS rebinding.
 */
const blocked = new BlockList()
blocked.addSubnet('169.254.0.0', 16, 'ipv4') // link-local: AWS, GCP, Azure, DigitalOcean, OpenStack ...
blocked.addAddress('100.100.100.200', 'ipv4') // Alibaba Cloud
blocked.addSubnet('fe80::', 10, 'ipv6')
blocked.addAddress('fd00:ec2::254', 'ipv6') // AWS, IPv6
blocked.addAddress('fd20:ce::254', 'ipv6') // GCP, IPv6

// Names a metadata service answers to. Through a proxy the name is resolved by the proxy, so the list is the only check.
const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata.goog', 'metadata', 'instance-data', 'instance-data.ec2.internal'])

/** For hosts that sit on a trusted network where nothing else can reach the metadata service. */
export function metadataTargetsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MONITOR_ALLOW_METADATA'] === 'true'
}

/** Why `host` (a name or an address literal) may not be connected to, or null. */
export function refusalReason(host: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (metadataTargetsAllowed(env)) return null
  const name = host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (BLOCKED_HOSTS.has(name)) return `${name} is a cloud metadata host`
  const family = isIP(name)
  // BlockList checks IPv4-mapped IPv6 addresses against the IPv4 rules.
  if (family !== 0 && blocked.check(name, family === 6 ? 'ipv6' : 'ipv4')) return `${name} is a link-local or cloud metadata address`
  return null
}

function refusal(host: string, reason: string): Error {
  return Object.assign(new Error(`Refusing to connect to ${host}: ${reason}`), { code: 'EBLOCKED' })
}

const systemLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => callback(error, addresses))
}

/** `inner` is the resolver being guarded (a caching one, say); it must answer with `all: true`. */
export function guardedLookup(inner: LookupFunction = systemLookup): LookupFunction {
  return (hostname, options, callback): void => {
    const hostReason = refusalReason(hostname)
    if (hostReason) return callback(refusal(hostname, hostReason), [])
    inner(hostname, { ...options, all: true }, (error, resolved) => {
      if (error) return callback(error, [])
      const addresses = resolved as LookupAddress[]
      for (const entry of addresses) {
        const reason = refusalReason(entry.address)
        if (reason) return callback(refusal(hostname, reason), [])
      }
      const first = addresses[0]
      if (!first) return callback(refusal(hostname, 'no address'), [])
      if (options.all) callback(null, addresses)
      else callback(null, first.address, first.family)
    })
  }
}

/**
 * For undici agents. The lookup guard alone is not enough: a socket opened to an address literal
 * (`http://169.254.169.254/`, also as the target of a redirect) never resolves anything.
 */
export function guardedConnector(options: { lookup?: LookupFunction; rejectUnauthorized?: boolean } = {}): buildConnector.connector {
  const connect = buildConnector({
    lookup: guardedLookup(options.lookup),
    ...(options.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: options.rejectUnauthorized }),
  })
  return (opts, callback) => {
    const reason = refusalReason(opts.hostname)
    if (reason) return callback(refusal(opts.hostname, reason), null)
    return connect(opts, callback)
  }
}

/** Throws for a URL whose host may not be connected to. */
export function assertTargetAllowed(url: string): void {
  const host = new URL(url).hostname
  const reason = refusalReason(host)
  if (reason) throw refusal(host, reason)
}

/**
 * For HTTP checks: honours HTTP_PROXY, HTTPS_PROXY and NO_PROXY. A request that goes through a proxy
 * connects to the proxy, so the connector never sees the target; it is checked in `proxiedFetch` instead.
 * Names are resolved by the proxy then, which the lookup guard cannot see. A plain http target is sent to
 * the proxy as an ordinary request, so a proxy that allows CONNECT only to port 443 still serves it.
 */
export function proxyAwareAgent(options: { lookup?: LookupFunction; rejectUnauthorized?: boolean; keepAlive?: boolean } = {}): EnvHttpProxyAgent {
  const { keepAlive, ...connector } = options
  return new EnvHttpProxyAgent({
    connect: guardedConnector(connector),
    proxyTunnel: false,
    ...(options.rejectUnauthorized === undefined ? {} : { requestTls: { rejectUnauthorized: options.rejectUnauthorized } }),
    ...(keepAlive ? { keepAliveTimeout: 5 * 60_000, keepAliveMaxTimeout: 30 * 60_000 } : {}),
  })
}

/**
 * The proxy a connection to `url` goes through, from the same variables the agent above reads, or null
 * when it is reached directly. For code that opens its own sockets and so cannot use the agent.
 */
export function proxyFor(url: string, env: NodeJS.ProcessEnv = process.env): URL | null {
  const target = new URL(url)
  const https = target.protocol === 'https:'
  const value = https
    ? env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY
    : env.http_proxy || env.HTTP_PROXY
  if (!value) return null
  const port = target.port || (https ? '443' : '80')
  const host = target.hostname.toLowerCase()
  for (const entry of (env.no_proxy ?? env.NO_PROXY ?? '').split(/[\s,]+/).filter(Boolean)) {
    if (entry === '*') return null
    const m = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(entry)
    if (!m?.[1]) continue
    if (m[2] && m[2] !== port) continue
    const name = m[1].replace(/^\*?\./, '').toLowerCase()
    if (host === name || host === name.replace(/^\[(.*)\]$/, '$1') || host.endsWith(`.${name}`)) return null
  }
  return new URL(value.includes('://') ? value : `http://${value}`)
}

/**
 * A socket to `host:port` through a `CONNECT` tunnel of `proxy`, for code that speaks its own protocol
 * (the caller checks the target with `refusalReason` first; the proxy resolves the name). Rejects
 * with the proxy's own status when it refuses.
 */
export function openTunnel(proxy: URL, host: string, port: number, timeoutMs: number): Promise<Socket> {
  const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`
  const credentials = proxy.username ? `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}` : ''
  return new Promise((resolve, reject) => {
    const tunnel = httpRequest({
      host: proxy.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority, ...(credentials ? { 'proxy-authorization': `Basic ${Buffer.from(credentials).toString('base64')}` } : {}) },
      timeout: timeoutMs,
    })
    tunnel.once('connect', (res, socket, head) => {
      if (res.statusCode === 200) {
        // A server that speaks first can have its greeting in the same packet as the proxy's answer.
        if (head.length) socket.unshift(head)
        return resolve(socket)
      }
      socket.destroy()
      reject(new Error(`Proxy response (${res.statusCode}) !== 200 when HTTP Tunneling`))
    })
    tunnel.once('timeout', () => { tunnel.destroy(); reject(new Error('Timed out connecting to the proxy')) })
    tunnel.once('error', reject)
    tunnel.end()
  })
}

const PROXY_VARIABLES = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY']

export function proxiedFetch(agent: EnvHttpProxyAgent): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    assertTargetAllowed(url)
    try {
      return await (undiciFetch(url as Parameters<typeof undiciFetch>[0], { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>)
    } catch (error) {
      // "fetch failed" hides whether the proxy refused (407, 403 on the tunnel) or could not be reached; the reason is the deepest cause.
      if (PROXY_VARIABLES.some((name) => process.env[name])) {
        let reason: Error | undefined
        for (let e: unknown = error; e instanceof Error; e = e.cause) {
          if ((e as { code?: unknown }).code === 'EBLOCKED') throw error
          reason = e
        }
        if (reason && reason !== error) throw new Error(reason.message, { cause: error })
      }
      throw error
    }
  }
}

/** For requests to an address someone typed in. */
export const guardedAgent = new Agent({ connect: guardedConnector() })

/** undici reports a refused connection as "fetch failed"; the reason is the cause. */
export function unwrapRefusal(error: unknown): unknown {
  const cause = error instanceof Error ? error.cause : undefined
  return cause instanceof Error && (cause as { code?: unknown }).code === 'EBLOCKED' ? cause : error
}

/**
 * A one-off request to an address someone typed in, or to the fixed host of a service. Goes through the
 * outbound proxy like an HTTP check; the connection pool is shared by all such requests.
 */
export const guardedFetch = followRedirects(proxiedFetch(proxyAwareAgent())) as unknown as typeof fetch

const MAX_REDIRECTS = 10

/**
 * Through a proxy the connector never sees the target, so a redirect has to be checked before it is requested: the
 * redirects are followed here, each target passing through `send` (which checks it). `redirect: 'manual'` and `'error'` are left alone.
 */
function followRedirects(send: (url: string, init: RequestInit) => Promise<Response>): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init = {}) => {
    if (init.redirect === 'manual' || init.redirect === 'error') return send(url, init)
    let current = url
    let next: RequestInit = { ...init, redirect: 'manual' }
    for (let hop = 0; ; hop++) {
      const res = await send(current, next)
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (!location) return res
      if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects')
      await res.body?.cancel().catch(() => undefined)
      current = new URL(location, current).href
      // As fetch does: 303, and 301 or 302 after a POST, continue as a GET without a body.
      const method = (next.method ?? 'GET').toUpperCase()
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        const { body: _body, ...rest } = next
        next = { ...rest, method: 'GET' }
      }
    }
  }
}

/**
 * Requests to the fixed hosts of a service (Telegram, Pushover, Twilio, ntfy.sh). They are not an address someone typed in,
 * so without an outbound proxy configured they use the platform's fetch as before.
 */
export const serviceFetch: typeof fetch = (url, init) =>
  PROXY_VARIABLES.some((name) => process.env[name]) ? guardedFetch(url, init) : fetch(url, init)
