import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SnapshotBanner } from './SnapshotBanner'

const source = vi.hoisted(() => ({ snapshot: null as unknown }))

vi.mock('../dataSource', () => ({
  SNAPSHOT_URL: '/snapshot.json',
  loadSnapshot: async () => source.snapshot,
  snapshotStaleMs: (s: { intervalSeconds?: number }) => (s.intervalSeconds ? 3000 * s.intervalSeconds : 600_000),
}))
vi.mock('../i18n/LocaleContext', () => ({
  useLocale: () => ({ locale: 'en', t: (key: string) => key }),
}))

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)

function renderBanner() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><SnapshotBanner /></QueryClientProvider>)
}

describe('SnapshotBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('turns into a warning as the unchanged snapshot ages', async () => {
    source.snapshot = { generatedAt: NOW, intervalSeconds: 60 }
    renderBanner()
    const fresh = await screen.findByText('snapshot.currentAsOf')
    // A new time every minute is not read out.
    expect(fresh).toHaveAttribute('aria-live', 'off')

    // Three minutes later nothing was refetched, yet the page must notice the age.
    await act(async () => { vi.setSystemTime(NOW + 4 * 60_000); await vi.advanceTimersByTimeAsync(15_000) })
    // Once it is old, that is read out.
    expect(screen.getByText('snapshot.stale')).toHaveAttribute('aria-live', 'polite')
  })

  it('shows nothing when the copy is meant to look like the live page', async () => {
    source.snapshot = { generatedAt: NOW, intervalSeconds: 60, showBanner: false }
    renderBanner()
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(screen.queryByText(/snapshot\./)).not.toBeInTheDocument()
  })
})
