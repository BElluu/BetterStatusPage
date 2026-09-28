import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageSwitcher } from './LanguageSwitcher'

const localeState = vi.hoisted(() => ({
  t: (key: string) => (key === 'page.changeLanguage' ? 'Change language' : key),
  locale: 'en',
  availableLocales: [
    { code: 'en', name: 'English' },
    { code: 'pl', name: 'Polski' },
  ],
  setLocale: vi.fn(),
}))

vi.mock('../i18n/LocaleContext', () => ({
  useLocale: () => localeState,
}))

describe('LanguageSwitcher', () => {
  beforeEach(() => {
    localeState.locale = 'en'
    localeState.availableLocales = [
      { code: 'en', name: 'English' },
      { code: 'pl', name: 'Polski' },
    ]
    localeState.setLocale.mockReset()
  })

  it('opens the locale menu and selects a language', async () => {
    const user = userEvent.setup()
    render(<LanguageSwitcher />)

    await user.click(screen.getByRole('button', { name: 'Change language' }))
    await user.click(screen.getByRole('button', { name: 'Polski' }))

    expect(localeState.setLocale).toHaveBeenCalledWith('pl')
    expect(screen.queryByRole('button', { name: 'Polski' })).not.toBeInTheDocument()
  })

  it('announces its state, marks the active language and closes on Escape or an outside click', async () => {
    const user = userEvent.setup()
    render(<><LanguageSwitcher /><p>Outside</p></>)
    const trigger = screen.getByRole('button', { name: 'Change language' })

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'Polski' })).not.toHaveAttribute('aria-current')

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('button', { name: 'Polski' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    await user.click(trigger)
    await user.click(screen.getByText('Outside'))
    expect(screen.queryByRole('button', { name: 'Polski' })).not.toBeInTheDocument()
  })

  it('stays hidden when no alternative locale exists', () => {
    localeState.availableLocales = [{ code: 'en', name: 'English' }]
    const { container } = render(<LanguageSwitcher />)
    expect(container).toBeEmptyDOMElement()
  })
})
