import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicSubscriptionOptions } from '@bsp/shared'
import { EN_DEFAULTS } from '../i18n/defaults'
import { SubscribeDialog, SubscriptionLinkDialog, readSubscriptionLink } from './Subscriptions'

vi.mock('../i18n/LocaleContext', () => ({
  useLocale: () => ({ t: (key: keyof typeof EN_DEFAULTS) => EN_DEFAULTS[key] ?? key }),
}))

const options: PublicSubscriptionOptions = {
  methods: ['email'],
  events: ['incident.created', 'incident.resolved'],
  allowComponentScope: true,
  components: [{ id: 1, name: 'API' }, { id: 2, name: 'Website' }],
  tags: ['core'],
  baseUrl: null,
}

/** Method buttons are named by their title followed by a short description. */
async function choose(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole('button', { name: new RegExp(`^${title.replace(/[/]/g, '\\/')}`) }))
}

function mockFetch(response: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('SubscribeDialog', () => {
  it('submits the chosen events and components, then asks to check the inbox', async () => {
    const user = userEvent.setup()
    const fetchMock = mockFetch({ ok: true }, 202)
    render(<SubscribeDialog options={options} onClose={() => {}} />)

    await choose(user, 'Email')
    await user.type(screen.getByLabelText('Email address'), 'reader@example.com')
    await user.click(screen.getByLabelText('New incidents'))
    await user.click(screen.getByLabelText('All components'))
    await user.click(screen.getByLabelText('Website'))
    await user.click(screen.getByRole('button', { name: 'Subscribe' }))

    expect(await screen.findByText(/check your inbox/i)).toBeInTheDocument()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/public/subscriptions')
    expect(JSON.parse(String(init.body))).toEqual({
      type: 'email', email: 'reader@example.com', events: ['incident.resolved'], monitorIds: [2], tags: [], website: '',
    })
  })

  it('sends a customized webhook request with a confirmation email and failure alerts', async () => {
    const user = userEvent.setup()
    const fetchMock = mockFetch({ ok: true }, 202)
    render(<SubscribeDialog options={{ ...options, methods: ['email', 'webhook'] }} onClose={() => {}} />)

    await choose(user, 'Webhook')
    await user.type(screen.getByLabelText('Webhook URL'), 'https://hooks.example.com/status')
    await user.type(screen.getByLabelText('Email address'), 'ops@example.com')
    expect(screen.getByLabelText('Email me if my URL stops responding')).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Customize request' }))
    await user.selectOptions(screen.getByLabelText('HTTP method'), 'PUT')
    await user.click(screen.getByRole('button', { name: 'Add header' }))
    await user.type(screen.getByLabelText('Name'), 'Authorization')
    await user.type(screen.getByLabelText('Value'), 'Bearer abc')
    // A blank row is dropped rather than rejected.
    await user.click(screen.getByRole('button', { name: 'Add header' }))
    await user.click(screen.getByRole('button', { name: 'Subscribe' }))

    expect(await screen.findByText(/check your inbox/i)).toBeInTheDocument()
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body).toMatchObject({
      type: 'webhook', email: 'ops@example.com', webhookUrl: 'https://hooks.example.com/status',
      webhookMethod: 'PUT', webhookHeaders: [{ name: 'Authorization', value: 'Bearer abc' }], notifyOnFailure: true,
    })
  })

  it('offers to resume a paused webhook without resending saved header values', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({
      type: 'webhook', email: 'op••••@example.com', webhookUrl: 'https://hooks.example.com/status', webhookMethod: 'POST',
      webhookHeaderNames: ['Authorization'], notifyOnFailure: true,
      status: init?.method === 'PUT' ? 'active' : 'disabled',
      events: ['incident.created'], monitorIds: [], tags: [],
    })))
    vi.stubGlobal('fetch', fetchMock)
    render(<SubscriptionLinkDialog link={{ mode: 'manage', token: 'manage-token' }} options={options} onClose={() => {}} />)

    expect(await screen.findByText(/paused because it kept failing/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Unchanged')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Turn back on' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const body = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))
    expect(body).toMatchObject({ token: 'manage-token', resubscribe: true, webhookHeaders: [{ name: 'Authorization', value: '' }] })
  })

  it('builds the Slack /feed command from the server public URL', async () => {
    const user = userEvent.setup()
    const fetchMock = mockFetch({})
    render(<SubscribeDialog options={{ ...options, methods: ['email', 'slack'], baseUrl: 'https://status.example.com' }} onClose={() => {}} />)

    await choose(user, 'Slack')
    expect(screen.getByText('/feed subscribe https://status.example.com/api/v1/public/slack.rss')).toBeInTheDocument()
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('lists the JSON status API endpoints to copy', async () => {
    const user = userEvent.setup()
    render(<SubscribeDialog options={{ ...options, methods: ['api'] }} onClose={() => {}} />)
    await choose(user, 'API')
    expect(screen.getByText(`${window.location.origin}/api/v1/public/summary.json`)).toBeInTheDocument()
    expect(screen.getByText(`${window.location.origin}/api/v1/public/components.json`)).toBeInTheDocument()
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument()
  })

  it('always starts by asking which method to use, and can go back to the list', async () => {
    const user = userEvent.setup()
    render(<SubscribeDialog options={{ ...options, methods: ['email', 'webhook', 'slack', 'rss', 'api'], baseUrl: null }} onClose={() => {}} />)

    expect(screen.getByText('How would you like to get updates?')).toBeInTheDocument()
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument()
    for (const title of ['Email', 'Webhook', 'Slack', 'RSS / Atom', 'API']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${title.replace('/', '\\/')}`) })).toBeInTheDocument()
    }

    await choose(user, 'RSS / Atom')
    expect(screen.getByText(`${window.location.origin}/api/v1/public/incidents.atom`)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'All options' }))
    expect(screen.getByText('How would you like to get updates?')).toBeInTheDocument()
  })

  it('asks for the method even when only one is offered', async () => {
    render(<SubscribeDialog options={{ ...options, methods: ['slack'], baseUrl: null }} onClose={() => {}} />)
    expect(screen.getByText('How would you like to get updates?')).toBeInTheDocument()
    expect(screen.queryByText(/\/feed subscribe/)).not.toBeInTheDocument()
  })

  it('cannot be submitted with every event unchecked', async () => {
    const user = userEvent.setup()
    render(<SubscribeDialog options={options} onClose={() => {}} />)
    await choose(user, 'Email')
    await user.click(screen.getByLabelText('New incidents'))
    await user.click(screen.getByLabelText('Resolved incidents'))
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeDisabled()
  })
})

describe('subscription links', () => {
  it('reads confirm, manage and unsubscribe links from the URL fragment only', () => {
    window.location.hash = '#subscription=manage&token=abc_123'
    expect(readSubscriptionLink()).toEqual({ mode: 'manage', token: 'abc_123' })
    window.location.hash = '#subscription=delete&token=abc'
    expect(readSubscriptionLink()).toBeNull()
  })

  it('confirms as soon as the email link is opened and shows only the result', async () => {
    const fetchMock = mockFetch({ type: 'email' })
    render(<SubscriptionLinkDialog link={{ mode: 'confirm', token: 'confirm-token' }} options={options} onClose={() => {}} />)

    expect(await screen.findByText(/Your subscription is confirmed/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'You are subscribed' })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/public/subscriptions/confirm')
    expect(JSON.parse(String(init.body))).toEqual({ token: 'confirm-token' })
    // No preferences here — the manage link arrives by email.
    expect(screen.queryByText('Notify me about')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unsubscribe' })).not.toBeInTheDocument()
  })

  it('confirms only once even when React runs the effect twice', async () => {
    const fetchMock = mockFetch({ type: 'email' })
    render(
      <StrictMode>
        <SubscriptionLinkDialog link={{ mode: 'confirm', token: 'confirm-token' }} options={options} onClose={() => {}} />
      </StrictMode>,
    )
    expect(await screen.findByText(/Your subscription is confirmed/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('explains an expired confirmation link', async () => {
    mockFetch({ error: 'Invalid or expired link' }, 404)
    render(<SubscriptionLinkDialog link={{ mode: 'confirm', token: 'old' }} options={options} onClose={() => {}} />)
    expect(await screen.findByText('This link is invalid or has expired.')).toBeInTheDocument()
  })

  it('explains an expired link', async () => {
    const user = userEvent.setup()
    mockFetch({ error: 'Invalid or expired link' }, 404)
    render(<SubscriptionLinkDialog link={{ mode: 'unsubscribe', token: 'old' }} options={options} onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Unsubscribe' }))
    expect(await screen.findByText('This link is invalid or has expired.')).toBeInTheDocument()
  })
})
