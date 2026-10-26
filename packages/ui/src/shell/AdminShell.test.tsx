import { lazy } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, getCurrentUser } from '../api/client'
import { configureUi } from '../config'
import { createAdminShell, type AdminShellConfig } from './AdminShell'

vi.mock('../api/client', () => ({
  api: { post: vi.fn() },
  clearSession: vi.fn(),
  getCurrentUser: vi.fn(),
}))

configureUi({ storagePrefix: 'kit' })

const config: AdminShellConfig = {
  sections: [
    { label: 'Overview', items: [
      { to: '/app/', label: 'Home', icon: 'home', minRole: 'member' },
      { to: '/app/things', label: 'Things', icon: 'inventory', minRole: 'member' },
      { to: '/app/reports', label: 'Reports', icon: 'assessment', minRole: 'member' },
    ] },
    { label: 'Administration', items: [{ to: '/app/users', label: 'Users', icon: 'group', minRole: 'owner' }] },
  ],
  roleRank: { owner: 3, member: 2, guest: 1 },
  brand: { iconUrl: '/icon.png', name: 'Kit', title: 'Console', subtitle: 'Tools' },
  homePath: '/app/',
  settingsPath: '/app/settings',
  loginPath: '/app/login',
  externalLinks: [{ label: 'Documentation', icon: 'menu_book', href: () => 'https://docs.test' }],
  whatsNew: {
    changelog: '## [2.0.0] - 2026-01-02\n\n### Added\n\n- **Thing.** A new thing.\n\n## [1.0.0] - 2025-01-01\n\n### Added\n\n- First.\n',
    version: '2.0.0',
    docsUrl: 'https://docs.test',
  },
}
const Shell = createAdminShell(config)

function renderShell(path = '/app/things') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/*" element={<Shell />}>
          <Route path="things" element={<p>Things page</p>} />
          <Route path="reports" element={<p>Reports page</p>} />
          <Route path="users" element={<p>Users page</p>} />
        </Route>
        <Route path="/app/login" element={<p>Login page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

const as = (role: string) => vi.mocked(getCurrentUser).mockReturnValue({ userId: 1, email: 'x@example.test', role, mustChangePassword: false, twoFactorEnabled: false })

describe('admin shell', () => {
  afterEach(() => { vi.restoreAllMocks() })

  beforeEach(() => {
    localStorage.setItem('kit-dark-mode', 'false')
    localStorage.removeItem('kit-whatsnew-seen-1')
    as('member')
    vi.mocked(api.post).mockResolvedValue({})
  })

  it('shows only the sections the role may access and marks the current page', () => {
    renderShell()
    const sidebar = screen.getByRole('navigation', { name: 'Main' })
    expect(within(sidebar).getByRole('link', { name: /Things/ })).toHaveAttribute('aria-current', 'page')
    expect(within(sidebar).queryByRole('link', { name: /Users/ })).not.toBeInTheDocument()
    expect(within(sidebar).queryByText('Administration')).not.toBeInTheDocument()
    expect(screen.getByText('Things page')).toBeInTheDocument()
  })

  it('keeps the menu on screen while a lazy page is still being fetched', () => {
    as('member')
    const Pending = lazy(() => new Promise<{ default: () => JSX.Element }>(() => {}))
    render(
      <MemoryRouter initialEntries={['/app/things']}>
        <Routes>
          <Route path="/app/*" element={<Shell />}>
            <Route path="things" element={<Pending />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getAllByRole('link', { name: /Reports/ }).length).toBeGreaterThan(0)
    expect(screen.getByRole('status')).toHaveTextContent('Loading')
  })

  it('marks the home page only when it is exactly the current one', () => {
    renderShell('/app/things')
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: /Home/ })).not.toHaveAttribute('aria-current')
  })

  it('shows nothing of the navigation to a role that is not ranked', () => {
    as('stranger')
    renderShell()
    expect(within(screen.getByRole('navigation', { name: 'Main' })).queryAllByRole('link')).toHaveLength(0)
  })

  it('groups the pages by purpose for the highest role', () => {
    as('owner')
    renderShell('/app/users')
    const sidebar = screen.getByRole('navigation', { name: 'Main' })
    for (const label of ['Overview', 'Administration']) expect(within(sidebar).getByText(label)).toBeInTheDocument()
    expect(within(sidebar).getByRole('link', { name: /Users/ })).toHaveAttribute('aria-current', 'page')
  })

  it('opens the mobile drawer and closes it with Escape, restoring focus to the menu button', async () => {
    const user = userEvent.setup()
    renderShell()
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
    renderShell()

    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await user.click(screen.getByTestId('nav-drawer-overlay'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await user.click(screen.getByRole('button', { name: 'Close navigation' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('link', { name: /Reports/ }))
    expect(screen.getByText('Reports page')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('toggles dark mode and logs out to the sign-in page', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(screen.getAllByRole('button', { name: 'Dark Mode' })[0]!)
    expect(document.documentElement).toHaveClass('dark')
    await user.click(screen.getAllByRole('button', { name: 'Light Mode' })[0]!)
    expect(document.documentElement).not.toHaveClass('dark')

    await user.click(screen.getAllByRole('button', { name: 'Logout' })[0]!)
    expect(api.post).toHaveBeenCalledWith('/auth/logout')
    expect(await screen.findByText('Login page')).toBeInTheDocument()
  })

  it('links to the settings and to the external pages the application names', () => {
    renderShell()
    expect(screen.getAllByRole('link', { name: 'Documentation' })[0]).toHaveAttribute('href', 'https://docs.test')
    expect(screen.getAllByRole('link', { name: 'Settings' })[0]).toHaveAttribute('href', '/app/settings')
  })

  it("shows what's new once to a user who last saw an older version", async () => {
    localStorage.setItem('kit-whatsnew-seen-1', '1.0.0')
    const user = userEvent.setup()
    renderShell()
    const dialog = screen.getByRole('dialog', { name: "What's new" })
    expect(within(dialog).getByRole('link', { name: 'Full changelog' })).toHaveAttribute('href', 'https://docs.test/changelog/')
    expect(within(dialog).getByRole('heading', { name: "What's new in 2.0.0" })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Got it' }))
    expect(screen.queryByRole('dialog', { name: "What's new" })).not.toBeInTheDocument()
    expect(localStorage.getItem('kit-whatsnew-seen-1')).toBe('2.0.0')
  })

  it("shows no what's new on the first visit, only records the version", () => {
    renderShell()
    expect(screen.queryByRole('dialog', { name: "What's new" })).not.toBeInTheDocument()
    expect(localStorage.getItem('kit-whatsnew-seen-1')).toBe('2.0.0')
  })
})
