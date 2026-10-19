import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatusSnapshot } from '@bsp/shared'

const snapshot: StatusSnapshot = {
  schemaVersion: 1,
  generatedAt: 1_700_000_000_000,
  status: { monitors: [{ id: 1 }] },
  layout: { tree: { id: 'root' } },
  incidents: [{ id: 3 }, { id: 2 }, { id: 1 }],
  history: { '1:24:30': { monitorId: 1, hours: 24, buckets: [{ ts: 1 }] } },
  uptime: {
    '1': { days: [{ date: 'a', checksTotal: 10, checksUp: 10 }, { date: 'b', checksTotal: 10, checksUp: 5 }, { date: 'c', checksTotal: 10, checksUp: 10 }], overallUptimePct: 99 },
    // A file from before the days carried their counts.
    '2': { days: [{ date: 'a' }, { date: 'b' }], overallUptimePct: 98 },
  },
  locales: [{ code: 'en', name: 'English', isDefault: 1 }] as StatusSnapshot['locales'],
  translations: { en: { 'page.hero': 'Hi' } },
}

describe('answerFromSnapshot', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(snapshot))))
  })
  afterEach(() => vi.unstubAllGlobals())

  async function answer<T>(path: string) {
    const { answerFromSnapshot } = await import('./dataSource')
    return answerFromSnapshot<T>(path, '/snapshot.json')
  }

  it('serves the public paths from the snapshot', async () => {
    expect(await answer('/api/v1/public/status')).toEqual(snapshot.status)
    expect(await answer('/api/v1/public/layout')).toEqual(snapshot.layout)
    expect(await answer('/api/v1/public/locales')).toEqual(snapshot.locales)
    expect(await answer('/api/v1/public/locales/en')).toEqual({ translations: { 'page.hero': 'Hi' } })
    expect(await answer('/api/v1/public/locales/de')).toEqual({ translations: {} })
  })

  it('is never private and never signed in', async () => {
    expect(await answer('/api/v1/public/access')).toMatchObject({ private: false, signedIn: false })
  })

  it('limits the incidents and the uptime days like the live API', async () => {
    expect(await answer('/api/v1/public/incidents?limit=2')).toEqual([{ id: 3 }, { id: 2 }])
    expect(await answer('/api/v1/public/monitor/1/uptime?days=2')).toEqual({
      monitorId: 1, days: [{ date: 'b', checksTotal: 10, checksUp: 5 }, { date: 'c', checksTotal: 10, checksUp: 10 }], overallUptimePct: 75,
    })
  })

  it('counts the checks of the days asked for, as the live page does', async () => {
    const all = await answer<{ overallUptimePct: number }>('/api/v1/public/monitor/1/uptime?days=90')
    expect(all.overallUptimePct).toBeCloseTo(83.33, 1)
    const last = await answer<{ overallUptimePct: number }>('/api/v1/public/monitor/1/uptime?days=1')
    expect(last.overallUptimePct).toBe(100)
    // Without counts the stored figure is all there is.
    expect((await answer<{ overallUptimePct: number }>('/api/v1/public/monitor/2/uptime?days=1')).overallUptimePct).toBe(98)
  })

  it('answers a chart for the range the layout asks for', async () => {
    expect(await answer('/api/v1/public/monitor/1/history?hours=24&buckets=30')).toEqual({ monitorId: 1, hours: 24, buckets: [{ ts: 1 }] })
    expect(await answer('/api/v1/public/monitor/1/history')).toEqual({ monitorId: 1, hours: 24, buckets: [{ ts: 1 }] })
  })

  it('answers 404 for what the snapshot does not hold', async () => {
    await expect(answer('/api/v1/public/monitor/9/uptime?days=90')).rejects.toMatchObject({ status: 404 })
    await expect(answer('/api/v1/public/monitor/1/history?hours=48&buckets=30')).rejects.toMatchObject({ status: 404 })
  })

  it('refuses a file in another format', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...snapshot, schemaVersion: 2 }))))
    await expect(answer('/api/v1/public/status')).rejects.toMatchObject({ status: 0 })
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ hello: 'world' }))))
    await expect(answer('/api/v1/public/layout')).rejects.toMatchObject({ status: 0 })
  })

  it('calls a copy stale after three of its intervals', async () => {
    const { snapshotStaleMs } = await import('./dataSource')
    expect(snapshotStaleMs({ intervalSeconds: 60 })).toBe(180_000)
    expect(snapshotStaleMs({ intervalSeconds: 900 })).toBe(2_700_000)
    expect(snapshotStaleMs({})).toBe(600_000)
  })

  it('reads the file once for a burst of requests', async () => {
    await answer('/api/v1/public/status')
    await answer('/api/v1/public/layout')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
