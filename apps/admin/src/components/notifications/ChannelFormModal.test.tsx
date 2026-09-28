import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_ALERT_POLICY, type NotificationChannel } from '@bsp/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import ChannelFormModal from './ChannelFormModal'

vi.mock('../../api/client', () => ({
  api: { post: vi.fn(), patch: vi.fn() },
}))

type User = ReturnType<typeof userEvent.setup>

/** Field labels are not linked to their inputs, so resolve the control next to the label text. */
function field<T extends HTMLElement = HTMLInputElement>(label: string, index = 0): T {
  const labelElement = screen.getAllByText(label, { selector: 'label' })[index]
  const control = labelElement?.parentElement?.querySelector('input, select, textarea')
  if (!control) throw new Error(`No control for label ${label}`)
  return control as T
}

/** Toggles are role="switch" buttons named by their visible label. */
function toggle(label: string): HTMLElement {
  return screen.getByRole('switch', { name: label })
}

function renderModal(channel: NotificationChannel | null = null) {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  render(<ChannelFormModal channel={channel} onClose={onClose} onSaved={onSaved} />)
  return { onClose, onSaved }
}

function submittedBody(): Record<string, unknown> {
  return vi.mocked(api.post).mock.calls[0]?.[1] as Record<string, unknown>
}

async function create(user: User) {
  await user.click(screen.getByRole('button', { name: 'Create Channel' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledOnce())
  expect(vi.mocked(api.post).mock.calls[0]?.[0]).toBe('/admin/notifications/channels')
}

function channel(patch: Partial<NotificationChannel>): NotificationChannel {
  return {
    id: 5,
    name: 'Ops mail',
    type: 'email',
    config: { to: 'ops@example.test', subject: 'S', body: 'B' },
    enabled: 1,
    notifyOnRecovery: 0,
    alertPolicy: DEFAULT_ALERT_POLICY,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

describe('ChannelFormModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.post).mockResolvedValue({})
    vi.mocked(api.patch).mockResolvedValue({})
  })

  it('starts a new channel on the preselected type', () => {
    render(<ChannelFormModal channel={null} initialType="slack" onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Slack' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByPlaceholderText('https://hooks.slack.com/services/…')).toBeInTheDocument()
  })

  it('ignores the preselected type when editing', () => {
    render(<ChannelFormModal channel={channel({})} initialType="slack" onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Email' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('creates an email channel with the default template and policy', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderModal()

    await user.type(field('Name'), 'On-call')
    await user.type(field('To'), 'oncall@example.test')
    expect(field('Subject')).toHaveValue('Monitor {{monitor_name}} is {{status}}')
    expect(screen.getByText('{{monitor_list}}')).toBeInTheDocument()
    await create(user)

    expect(onSaved).toHaveBeenCalledOnce()
    const body = submittedBody()
    expect(body).toMatchObject({
      name: 'On-call',
      type: 'email',
      enabled: 1,
      notifyOnRecovery: 0,
      config: { to: 'oncall@example.test', subject: 'Monitor {{monitor_name}} is {{status}}' },
    })
    expect((body['config'] as { body: string }).body).toContain('Status:  {{status}}')
    const policy = body['alertPolicy'] as typeof DEFAULT_ALERT_POLICY
    expect(policy.throttle).toEqual(DEFAULT_ALERT_POLICY.throttle)
    expect(policy.grouping).toEqual(DEFAULT_ALERT_POLICY.grouping)
    expect(policy.quietHours).toMatchObject({ enabled: false, start: '22:00', end: '07:00', mode: 'defer' })
  })

  it('does not submit without a name', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.click(screen.getByRole('button', { name: 'Create Channel' }))

    expect(field('Name')).toBeInvalid()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('builds a webhook config with headers and drops the body for GET', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.type(field('Name'), 'Hook')
    await user.click(screen.getByRole('button', { name: /Webhook/ }))
    expect(screen.getByText('No custom headers.')).toBeInTheDocument()
    await user.type(field('URL'), 'https://hooks.example.test/alert')
    await user.click(screen.getByRole('button', { name: 'Add header' }))
    await user.type(screen.getByPlaceholderText('Header'), 'Authorization')
    await user.type(screen.getByPlaceholderText('Value'), 'Bearer x')
    // A row without a name is ignored.
    await user.click(screen.getByRole('button', { name: 'Add header' }))
    expect(field<HTMLTextAreaElement>('Body').value).toContain('"monitor": "{{monitor_name}}"')
    await user.selectOptions(field<HTMLSelectElement>('Method'), 'GET')
    expect(screen.queryByText('Body', { selector: 'label' })).not.toBeInTheDocument()
    await create(user)

    expect(submittedBody()['config']).toEqual({
      url: 'https://hooks.example.test/alert',
      method: 'GET',
      headers: { Authorization: 'Bearer x' },
      body: undefined,
    })
  })

  it('removes webhook headers and keeps the body for POST', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.type(field('Name'), 'Hook')
    await user.click(screen.getByRole('button', { name: /Webhook/ }))
    await user.type(field('URL'), 'https://hooks.example.test/alert')
    await user.click(screen.getByRole('button', { name: 'Add header' }))
    await user.click(screen.getAllByRole('button', { name: /^Remove header/ }).at(-1)!)
    await user.clear(field('Body'))
    await user.click(field('Body'))
    await user.paste('{"s":"{{status}}"}')
    await create(user)

    expect(submittedBody()['config']).toEqual({
      url: 'https://hooks.example.test/alert',
      method: 'POST',
      headers: undefined,
      body: '{"s":"{{status}}"}',
    })
  })

  it.each([
    {
      type: 'Discord',
      fill: async (user: User) => {
        await user.type(field('Webhook URL'), 'https://discord.test/hook')
        await user.type(field('Bot Username (optional)'), 'BSP')
        await user.click(field('Message Content (optional)'))
        await user.paste('@here {{status}}')
      },
      config: { webhookUrl: 'https://discord.test/hook', username: 'BSP', content: '@here {{status}}' },
      bare: { webhookUrl: 'https://discord.test/hook' },
    },
    {
      type: 'Teams',
      fill: async (user: User) => {
        await user.type(field('Webhook URL'), 'https://teams.test/hook')
        await user.type(field('Summary (optional)'), 'Alert')
      },
      config: { webhookUrl: 'https://teams.test/hook', summary: 'Alert' },
      bare: { webhookUrl: 'https://teams.test/hook' },
    },
    {
      type: 'Slack',
      fill: async (user: User) => {
        await user.type(field('Webhook URL'), 'https://slack.test/hook')
        await user.type(field('Message Text (optional)'), 'Heads up')
      },
      config: { webhookUrl: 'https://slack.test/hook', text: 'Heads up' },
      bare: { webhookUrl: 'https://slack.test/hook' },
    },
  ])('builds the $type config and omits empty optional fields', async ({ type, fill, config, bare }) => {
    const user = userEvent.setup()
    renderModal()

    await user.type(field('Name'), type)
    await user.click(screen.getByRole('button', { name: type }))
    await fill(user)
    await create(user)
    expect(submittedBody()).toMatchObject({ type: type.toLowerCase(), config })

    vi.mocked(api.post).mockClear()
    for (const input of screen.getAllByRole('textbox').filter((el) => /optional/.test(el.parentElement?.textContent ?? ''))) {
      await user.clear(input)
    }
    await create(user)
    expect(submittedBody()['config']).toEqual(bare)
  })

  it('saves toggles and alert hygiene settings', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.type(field('Name'), 'Policy')
    await user.type(field('To'), 'ops@example.test')
    await user.click(toggle('Enabled'))
    await user.click(toggle('Notify on recovery (when monitor comes back up)'))

    expect(screen.queryByText('Quiet hours')).not.toBeInTheDocument()
    await user.click(screen.getByTitle('Alert hygiene'))
    expect(screen.queryByText('From', { selector: 'label' })).not.toBeInTheDocument()
    await user.click(toggle('Quiet hours'))
    fireEvent.change(field('From'), { target: { value: '23:00' } })
    // The email recipient field is also labelled "To".
    fireEvent.change(field('To', 1), { target: { value: '06:30' } })
    await user.selectOptions(field<HTMLSelectElement>('Timezone'), 'Europe/Warsaw')
    await user.selectOptions(field<HTMLSelectElement>('During the window'), 'suppress')

    await user.click(toggle('Rate cap per monitor'))
    fireEvent.change(field('Max alerts'), { target: { value: '0' } })
    fireEvent.change(field('Per (minutes)'), { target: { value: '15' } })

    await user.click(toggle('Group bursts into one message'))
    fireEvent.change(field('From (monitors)'), { target: { value: '1' } })
    fireEvent.change(field('Within (seconds)'), { target: { value: '5' } })
    // The tab badge counts the active policies.
    expect(screen.getByTitle('Alert hygiene')).toHaveTextContent('3')
    await create(user)

    expect(submittedBody()).toMatchObject({
      enabled: 0,
      notifyOnRecovery: 1,
      alertPolicy: {
        quietHours: { enabled: true, start: '23:00', end: '06:30', timezone: 'Europe/Warsaw', mode: 'suppress' },
        // Values below the minimum are clamped rather than rejected.
        throttle: { enabled: true, maxAlerts: 1, windowMinutes: 15 },
        grouping: { enabled: true, minMonitors: 2, windowSeconds: 10 },
      },
    })
  })

  it('pre-fills an existing webhook channel and saves with PATCH', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderModal(channel({
      name: 'Pager hook',
      type: 'webhook',
      config: { url: 'https://pager.test', method: 'PUT', headers: { 'X-Key': 'k' }, body: '{}' },
      notifyOnRecovery: 1,
      alertPolicy: { ...DEFAULT_ALERT_POLICY, throttle: { enabled: true, maxAlerts: 5, windowMinutes: 30 } },
    }))

    expect(screen.getByRole('heading', { name: 'Edit Channel' })).toBeInTheDocument()
    expect(field('URL')).toHaveValue('https://pager.test')
    expect(field<HTMLSelectElement>('Method')).toHaveValue('PUT')
    expect(screen.getByPlaceholderText('Header')).toHaveValue('X-Key')
    expect(screen.getByTitle('Alert hygiene')).toHaveTextContent('1')
    await user.click(screen.getByTitle('Alert hygiene'))
    expect(field('Max alerts')).toHaveValue(5)

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(api.patch).toHaveBeenCalledWith('/admin/notifications/channels/5', expect.objectContaining({
      name: 'Pager hook',
      config: { url: 'https://pager.test', method: 'PUT', headers: { 'X-Key': 'k' }, body: '{}' },
      notifyOnRecovery: 1,
    }))
  })

  it('fills policy sections missing from older channels with defaults', async () => {
    const user = userEvent.setup()
    renderModal(channel({ alertPolicy: {} as NotificationChannel['alertPolicy'] }))

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(api.patch).toHaveBeenCalledOnce())
    const policy = (vi.mocked(api.patch).mock.calls[0]?.[1] as { alertPolicy: typeof DEFAULT_ALERT_POLICY }).alertPolicy
    expect(policy.throttle).toEqual(DEFAULT_ALERT_POLICY.throttle)
    expect(policy.grouping).toEqual(DEFAULT_ALERT_POLICY.grouping)
    expect(policy.quietHours.enabled).toBe(false)
  })

  it('keeps an unknown stored timezone selectable', async () => {
    const user = userEvent.setup()
    renderModal(channel({
      alertPolicy: { ...DEFAULT_ALERT_POLICY, quietHours: { ...DEFAULT_ALERT_POLICY.quietHours, enabled: true, timezone: 'Mars/Olympus' } },
    }))

    await user.click(screen.getByTitle('Alert hygiene'))
    expect(field<HTMLSelectElement>('Timezone')).toHaveValue('Mars/Olympus')
  })

  it('sends a test notification for an existing channel', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('SMTP not configured'))
    renderModal(channel({}))

    await user.click(screen.getByRole('button', { name: 'Send test (saved settings)' }))
    expect(await screen.findByText('Test sent successfully')).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledWith('/admin/notifications/channels/5/test', {})

    await user.click(screen.getByRole('button', { name: 'Send test (saved settings)' }))
    expect(await screen.findByText('SMTP not configured')).toBeInTheDocument()
  })

  it('disables the saved-settings test while the form has unsaved edits', async () => {
    const user = userEvent.setup()
    renderModal(channel({}))

    const test = screen.getByRole('button', { name: 'Send test (saved settings)' })
    expect(test).toBeEnabled()
    await user.type(screen.getByLabelText('Name'), ' edited')
    expect(test).toBeDisabled()
    expect(test).toHaveAccessibleDescription(/Save your changes first/)
  })

  it('is a labelled dialog that closes on Escape', async () => {
    const user = userEvent.setup()
    const { onClose } = renderModal()

    expect(screen.getByRole('dialog', { name: 'New Notification Channel' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('offers no test for a channel that is not saved yet', () => {
    renderModal()
    expect(screen.queryByRole('button', { name: 'Send test (saved settings)' })).not.toBeInTheDocument()
  })

  it('shows a save error and stays open', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Invalid webhook URL'))
    const { onSaved } = renderModal()

    await user.type(field('Name'), 'Broken')
    await user.type(field('To'), 'ops@example.test')
    await user.click(screen.getByRole('button', { name: 'Create Channel' }))

    expect(await screen.findByText('Invalid webhook URL')).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('closes from the cancel button', async () => {
    const user = userEvent.setup()
    const { onClose } = renderModal()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
