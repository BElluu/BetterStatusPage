import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider, useLocale } from './LocaleContext'

function mockApi(routes: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (!(url in routes)) throw new Error(`Unexpected fetch ${url}`)
    return new Response(JSON.stringify(routes[url]))
  })
}

function Probe() {
  const { locale, availableLocales, t, setLocale } = useLocale()
  return (
    <div>
      <p data-testid="locale">{locale}</p>
      <p data-testid="available">{availableLocales.map((l) => l.code).join(',')}</p>
      <p data-testid="hero">{t('page.hero')}</p>
      <p data-testid="monitored">{t('page.monitoredLine', { n: 4 })}</p>
      <button type="button" onClick={() => setLocale('en')}>English</button>
    </div>
  )
}

const locales = [
  { code: 'en', name: 'English', isDefault: 0 },
  { code: 'pl', name: 'Polski', isDefault: 1 },
  { code: 'de', name: 'Deutsch', isDefault: 0 },
]
const polish = { translations: { 'page.hero': 'Status sieci w czasie rzeczywistym', 'page.monitoredLine': '{n} monitorowanych usług.' } }

describe('LocaleProvider', () => {
  const storage = window.localStorage

  beforeEach(() => {
    storage.clear()
  })

  it('falls back to English defaults outside a provider', () => {
    render(<Probe />)
    expect(screen.getByTestId('hero')).toHaveTextContent('Real-time Network Status')
  })

  it('substitutes parameters outside a provider', () => {
    render(<Probe />)
    expect(screen.getByTestId('monitored')).toHaveTextContent('4 services monitored in real time.')
  })

  it('switches to the instance default locale and loads its translations', async () => {
    mockApi({ '/api/v1/public/locales': locales, '/api/v1/public/locales/pl': polish })
    render(<LocaleProvider><Probe /></LocaleProvider>)

    await waitFor(() => expect(screen.getByTestId('hero')).toHaveTextContent('Status sieci w czasie rzeczywistym'))
    expect(screen.getByTestId('locale')).toHaveTextContent('pl')
    expect(screen.getByTestId('available')).toHaveTextContent('en,pl,de')
    expect(screen.getByTestId('monitored')).toHaveTextContent('4 monitorowanych usług.')
    expect(document.documentElement.lang).toBe('pl')
  })

  it('keeps a saved language the instance still offers', async () => {
    storage.setItem('bsp-locale', 'de')
    const fetch = mockApi({ '/api/v1/public/locales': locales, '/api/v1/public/locales/de': { translations: {} } })
    render(<LocaleProvider><Probe /></LocaleProvider>)

    await waitFor(() => expect(screen.getByTestId('available')).toHaveTextContent('en,pl,de'))
    expect(screen.getByTestId('locale')).toHaveTextContent('de')
    // Keys the locale does not translate fall back to English.
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/v1/public/locales/de'))
    expect(screen.getByTestId('hero')).toHaveTextContent('Real-time Network Status')
  })

  it('replaces a saved language that was removed', async () => {
    storage.setItem('bsp-locale', 'fr')
    mockApi({
      '/api/v1/public/locales': locales,
      '/api/v1/public/locales/fr': { translations: {} },
      '/api/v1/public/locales/pl': polish,
    })
    render(<LocaleProvider><Probe /></LocaleProvider>)

    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('pl'))
  })

  it('falls back to English when no locale is marked default', async () => {
    mockApi({ '/api/v1/public/locales': locales.map((l) => ({ ...l, isDefault: 0 })) })
    render(<LocaleProvider><Probe /></LocaleProvider>)

    await waitFor(() => expect(screen.getByTestId('available')).toHaveTextContent('en,pl,de'))
    expect(screen.getByTestId('locale')).toHaveTextContent('en')
  })

  it('remembers a language chosen by the visitor', async () => {
    const user = userEvent.setup()
    mockApi({ '/api/v1/public/locales': locales, '/api/v1/public/locales/pl': polish })
    render(<LocaleProvider><Probe /></LocaleProvider>)
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('pl'))

    await user.click(screen.getByRole('button', { name: 'English' }))

    expect(storage.getItem('bsp-locale')).toBe('en')
    expect(screen.getByTestId('hero')).toHaveTextContent('Real-time Network Status')
  })

  it('fills keys a Polish locale leaves empty with the built-in Polish copy', async () => {
    mockApi({
      '/api/v1/public/locales': locales,
      '/api/v1/public/locales/pl': { translations: { 'page.hero': '', 'page.monitoredLine': 'Usługi: {n}' } },
    })
    render(<LocaleProvider><Probe /></LocaleProvider>)

    await waitFor(() => expect(screen.getByTestId('monitored')).toHaveTextContent('Usługi: 4'))
    expect(screen.getByTestId('hero')).toHaveTextContent('Status usług w czasie rzeczywistym')
  })

  it('uses built-in Polish copy when the locale endpoints fail', async () => {
    storage.setItem('bsp-locale', 'pl')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    render(<LocaleProvider><Probe /></LocaleProvider>)

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('hero')).toHaveTextContent('Status usług w czasie rzeczywistym')
    expect(screen.getByTestId('available')).toHaveTextContent('')
  })
})
