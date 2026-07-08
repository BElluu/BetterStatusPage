import type { FastifyServerOptions } from 'fastify'

export type TrustProxy = NonNullable<FastifyServerOptions['trustProxy']>

export function resolveTrustProxy(raw = process.env['TRUST_PROXY']): TrustProxy {
  const value = raw?.trim()
  if (!value || value.toLowerCase() === 'false') return false
  if (value.toLowerCase() === 'true') return true
  if (/^\d+$/.test(value)) return Number(value)
  const addresses = value.split(',').map((address) => address.trim()).filter(Boolean)
  if (addresses.length === 0) return false
  return addresses.length === 1 ? addresses[0]! : addresses
}
