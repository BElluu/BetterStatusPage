import type { FastifyServerOptions } from 'fastify'

export type TrustProxy = NonNullable<FastifyServerOptions['trustProxy']>

export function resolveTrustProxy(raw = process.env['TRUST_PROXY']): TrustProxy {
  const value = raw?.trim()
  if (!value || value.toLowerCase() === 'false') return false
  if (value.toLowerCase() === 'true') return true
  if (/^\d+$/.test(value)) {
    // Hop-count-only trust can't validate the immediate peer, so @fastify/proxy-addr
    // no longer supports it (it always fails closed). Treat a numeric value as "trust a
    // proxy on this host or on a private network": loopback covers a proxy on the same
    // host, uniquelocal (10/8, 172.16/12, 192.168/16, fc00::/7) covers one reaching the
    // app over a Docker bridge network. Use an explicit address/CIDR list to narrow it.
    return ['loopback', 'uniquelocal']
  }
  const addresses = value.split(',').map((address) => address.trim()).filter(Boolean)
  if (addresses.length === 0) return false
  return addresses.length === 1 ? addresses[0]! : addresses
}
