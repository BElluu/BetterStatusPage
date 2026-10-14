import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, getCurrentUser } from '../api/client'
import Layout from './Layout'

vi.mock('../api/client', () => ({
  api: { post: vi.fn() },
  clearSession: vi.fn(),
  getCurrentUser: vi.fn(),
}))

function renderLayout(path = '/admin/monitors') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/*" element={<Layout />}>
          <Route path="monitors" element={<p>Monitors page</p>} />
          <Route path="incidents" element={<p>Incidents page</p>} />
          <Route path="users" element={<p>Users page</p>} />
        </Route>
        <Route path="/admin/login" element={<p>Login page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Layout', () => {
  afterEach(() => { vi.restoreAllMocks() })

  beforeEach(() => {
    localStorage.setItem('bsp-dark-mode', 'false')
    localStorage.removeItem('bsp-whatsnew-seen-1')
    vi.mocked(getCurrentUser).mockReturnValue({ userId: 1, email: 'op@example.test', role: 'operator', mustChangePassword: false, twoFactorEnabled: false })
    vi.mocked(api.post).mockResolvedValue({})
  })

  it('shows only the sections the role may access and marks the current page', () => {
    renderLayout()
    const sidebar = screen.getByRole('navigation', { name: 'Main' })
    expect(within(sidebar).getByRole('link', { name: /Monitors/ })).toHaveAttribute('aria-current', 'page')
    expect(within(sidebar).queryByRole('link', { name: /Users/ })).not.toBeInTheDocument()
    expect(screen.getByText('Monitors page')).toBeInTheDocument()
  })

  it('opens the mobile drawer and closes it with Escape, restoring focus to the menu button', async () => {
    const user = userEvent.setup()
    renderLayout()
    const menu = screen.getByRole('button', { name: 'Open navigation' })
    expect(menu).toHaveAttribute('aria-expanded', 'false')

    await user.click(menu)
    const drawer = screen.getByRole('dialog', { name: 'Navigation' })
    expect(menu).toHaveAttribute('aria-expanded', 'true')
    expect(within(drawer).getByRole('button', { name: 'Close navigation' })).toHaveFocus()
    expect(within(drawer).getByRole('button', { name: 'Logout' })).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'Dark Mode' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument()
    expect(menu).toHaveFocus()
  })

  it('closes the drawer from the overlay, the close button and on navigation', async () => {
    const user = userEvent.setup()
    renderLayout()

    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await user.click(screen.getByTestId('nav-drawer-overlay'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await user.click(screen.getByRole('button', { name: 'Close navigation' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('link', { name: /Incidents/ }))
    expect(screen.getByText('Incidents page')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('toggles dark mode and logs out', async () => {
    const user = userEvent.setup()
    renderLayout()
    const sidebar = screen.getAllByRole('button', { name: 'Dark Mode' })[0]!
    await user.click(sidebar)
    expect(document.documentElement).toHaveClass('dark')
    await user.click(screen.getAllByRole('button', { name: 'Light Mode' })[0]!)
    expect(document.documentElement).not.toHaveClass('dark')

    await user.click(screen.getAllByRole('button', { name: 'Logout' })[0]!)
    expect(api.post).toHaveBeenCalledWith('/auth/logout')
    expect(await screen.findByText('Login page')).toBeInTheDocument()
  })

  it('links to the documentation', () => {
    renderLayout()
    expect(screen.getAllByRole('link', { name: 'Documentation' })[0]).toHaveAttribute('href', 'https://docs.betterstatuspage.dev')
  })

  it("shows what's new once to a user who last saw an older version", async () => {
    localStorage.setItem('bsp-whatsnew-seen-1', '0.0.1')
    const user = userEvent.setup()
    renderLayout()
    const dialog = screen.getByRole('dialog', { name: "What's new" })
    expect(within(dialog).getByRole('link', { name: 'Full changelog' })).toHaveAttribute('href', 'https://docs.betterstatuspage.dev/changelog/')
    expect(within(dialog).getByRole('heading', { name: /^What's new in \d+\.\d+\.\d+/ })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Got it' }))
    expect(screen.queryByRole('dialog', { name: "What's new" })).not.toBeInTheDocument()
    expect(localStorage.getItem('bsp-whatsnew-seen-1')).not.toBe('0.0.1')
  })

  it("shows no what's new on the first visit, only records the version", () => {
    localStorage.removeItem('bsp-whatsnew-seen-1')
    renderLayout()
    expect(screen.queryByRole('dialog', { name: "What's new" })).not.toBeInTheDocument()
    expect(localStorage.getItem('bsp-whatsnew-seen-1')).not.toBeNull()
  })

  it('groups the pages by purpose for an administrator', () => {
    vi.mocked(getCurrentUser).mockReturnValue({ userId: 1, email: 'admin@example.test', role: 'admin', mustChangePassword: false, twoFactorEnabled: false })
    renderLayout('/admin/users')
    const sidebar = screen.getByRole('navigation', { name: 'Main' })
    for (const label of ['Monitoring', 'Alerts', 'Status page', 'Administration']) expect(within(sidebar).getByText(label)).toBeInTheDocument()
    expect(within(sidebar).getByRole('link', { name: /Backups/ })).toBeInTheDocument()
    expect(within(sidebar).getByRole('link', { name: /Users/ })).toHaveAttribute('aria-current', 'page')
    expect(within(sidebar).queryByRole('link', { name: /Import/ })).not.toBeInTheDocument()
  })
})
