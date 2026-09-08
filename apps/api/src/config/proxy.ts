import type { FastifyServerOptions } from 'fastify'

export type TrustProxy = NonNullable<FastifyServerOptions['trustProxy']>

export function resolveTrustProxy(raw = process.env['TRUST_PROXY']): TrustProxy {
  const value = raw?.trim()
  if (!value || value.toLowerCase() === 'false') return false
  if (value.toLowerCase() === 'true') return true
  if (/^\d+$/.test(value)) {
    // Hop-count-only trust can't validate the immediate peer, so @fastify/proxy-addr
    // no longer supports it (it always fails closed). The only documented deployment
    // puts the reverse proxy on the same host, forwarding to loopback, so treat a
    // numeric value as "trust the loopback interface" to keep TRUST_PROXY=1 working.
    return ['127.0.0.1', '::1']
  }
  const addresses = value.split(',').map((address) => address.trim()).filter(Boolean)
  if (addresses.length === 0) return false
  return addresses.length === 1 ? addresses[0]! : addresses
}
