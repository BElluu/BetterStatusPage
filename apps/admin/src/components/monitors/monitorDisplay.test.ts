import { describe, expect, it } from 'vitest'
import { failingFor, formatPercent, isSlower, monitorEndpoint } from './monitorDisplay'

const health = (failureRunSince: number | null) => ({ uptime24h: null, avgResponseMs: null, responseTrend: [], failureRunSince, latencyRatio: null })

describe('formatPercent', () => {
  it.each([[100, '100%'], [99.8, '99.8%'], [94.14, '94.1%'], [0, '0%'], [99.96, '99.9%'], [99.99, '99.9%']])('writes %f as %s', (value, text) => {
    expect(formatPercent(value)).toBe(text)
  })
})

describe('failingFor', () => {
  const now = Date.UTC(2026, 10, 3, 12)
  it('says how long a down or degraded monitor has been failing', () => {
    expect(failingFor({ currentStatus: 'down', health: health(now - 14 * 60_000) }, now)).toBe('14 min')
    expect(failingFor({ currentStatus: 'degraded', health: health(now - 3_600_000) }, now)).toBe('1 h')
  })
  it('says nothing for a passing monitor or an unknown start', () => {
    expect(failingFor({ currentStatus: 'up', health: health(now - 60_000) }, now)).toBeUndefined()
    expect(failingFor({ currentStatus: 'down', health: health(null) }, now)).toBeUndefined()
  })
})

describe('isSlower', () => {
  it('is true only while a slower-than-usual alert is open', () => {
    expect(isSlower({ latencyAlertSince: Date.now() })).toBe(true)
    expect(isSlower({ latencyAlertSince: null })).toBe(false)
  })
})

describe('monitorEndpoint', () => {
  it('shows the address that is checked, else the type', () => {
    expect(monitorEndpoint({ type: 'https', config: { url: 'https://a.test' } } as never)).toBe('https://a.test')
    expect(monitorEndpoint({ type: 'ping', config: { host: '10.0.0.1' } } as never)).toBe('10.0.0.1')
    expect(monitorEndpoint({ type: 'dns', config: { hostname: 'a.test' } } as never)).toBe('a.test')
    expect(monitorEndpoint({ type: 'redis', config: {} } as never)).toBe('redis')
  })
})
