import { Resolver } from 'dns/promises'
import type { DnsConfig } from '@bsp/shared'
import type { MonitorStatus } from '@bsp/shared'

export async function checkDns(
  config: DnsConfig,
  timeoutMs: number,
): Promise<{ status: MonitorStatus; responseMs: number | null; error: string | null }> {
  const start = Date.now()
  try {
    const resolver = new Resolver()
    if (config.resolver) {
      resolver.setServers([config.resolver])
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('DNS query timed out')), timeoutMs),
    )

    const records: string[] = await Promise.race([
      (async () => {
        switch (config.recordType) {
          case 'A': return resolver.resolve4(config.hostname)
          case 'AAAA': return resolver.resolve6(config.hostname)
          case 'MX': {
            const mx = await resolver.resolveMx(config.hostname)
            return mx.map((r) => r.exchange)
          }
          case 'CNAME': return resolver.resolveCname(config.hostname)
          case 'TXT': {
            const txt = await resolver.resolveTxt(config.hostname)
            return txt.map((r) => r.join(''))
          }
          default: return resolver.resolve(config.hostname)
        }
      })(),
      timeoutPromise,
    ])

    const responseMs = Date.now() - start

    if (config.expectedValue && !records.some((r) => r.includes(config.expectedValue!))) {
      return {
        status: 'degraded',
        responseMs,
        error: `Expected "${config.expectedValue}" not found in: ${records.join(', ')}`,
      }
    }

    return { status: 'up', responseMs, error: null }
  } catch (err) {
    const responseMs = Date.now() - start
    return { status: 'down', responseMs, error: err instanceof Error ? err.message : String(err) }
  }
}
