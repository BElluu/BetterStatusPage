import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import SystemHealthPage from './SystemHealth'

vi.mock('../api/client', () => ({ api: { get: vi.fn() } }))

const report = {
  status: 'healthy' as const,
  generatedAt: 1_750_000_000_000,
  application: { status: 'ok' as const, version: '1.2.3', uptimeSeconds: 93_720 },
  database: { status: 'ok' as const, responseMs: 4 },
  monitoring: {
    status: 'attention' as const,
    schedulerRunning: true,
    configuredMonitors: 12,
    overdueMonitors: 1,
    lastMonitorCheckAt: 1_750_000_000_000,
    lastTickStartedAt: 1_750_000_000_000,
    lastTickCompletedAt: 1_750_000_000_050,
    lastTickDurationMs: 50,
    lastTickDueMonitors: 3,
    lastTickFailedChecks: 0,
  },
  notifications: { status: 'ok' as const, pending: 0, failed: 0, lastDeliveredAt: null },
  backups: {
    status: 'disabled' as const,
    scheduleEnabled: false,
    state: 'idle' as const,
    storedBackups: 2,
    latestBackupAt: 1_750_000_000_000,
    lastCompletedAt: 1_750_000_000_000,
  },
}

describe('SystemHealthPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue(report)
  })

  it('shows the protected health aggregates and refreshes them manually', async () => {
    const user = userEvent.setup()
    const view = render(<SystemHealthPage />)

    expect(await screen.findByText('BetterStatusPage is healthy')).toBeInTheDocument()
    expect(screen.getByText('1.2.3')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('Monitor scheduler')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledWith('/admin/system-health')

    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    view.unmount()
  })
})
