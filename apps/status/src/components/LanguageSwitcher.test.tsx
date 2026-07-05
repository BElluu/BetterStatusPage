import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageSwitcher } from './LanguageSwitcher'

const localeState = vi.hoisted(() => ({
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

  it('stays hidden when no alternative locale exists', () => {
    localeState.availableLocales = [{ code: 'en', name: 'English' }]
    const { container } = render(<LanguageSwitcher />)
    expect(container).toBeEmptyDOMElement()
  })
})
