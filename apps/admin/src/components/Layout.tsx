import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Outlet, NavLink, useNavigate, useLocation, Link } from 'react-router-dom'
import { api, clearSession, getCurrentUser } from '../api/client'
import { useDarkMode } from '../hooks/useDarkMode'

// role hierarchy: admin > operator > branding
const ROLE_RANK: Record<string, number> = { admin: 3, operator: 2, branding: 1 }

type NavItem = { to: string; label: string; icon: string; minRole: string }
type NavSection = { label: string; items: NavItem[] }

const ALL_SECTIONS: NavSection[] = [
  {
    label: 'Monitoring',
    items: [
      { to: '/admin/',            label: 'Dashboard',    icon: 'dashboard',            minRole: 'operator' },
      { to: '/admin/monitors',    label: 'Monitors',     icon: 'radio_button_checked', minRole: 'operator' },
      { to: '/admin/incidents',   label: 'Incidents',    icon: 'warning',              minRole: 'operator' },
      { to: '/admin/maintenance', label: 'Maintenance',  icon: 'construction',         minRole: 'operator' },
    ],
  },
  {
    label: 'Configure',
    items: [
      { to: '/admin/notifications', label: 'Notifications', icon: 'notifications',       minRole: 'operator' },
      { to: '/admin/subscribers',   label: 'Subscribers',   icon: 'campaign',            minRole: 'operator' },
      { to: '/admin/builder',       label: 'Page Builder',  icon: 'dashboard_customize', minRole: 'branding' },
      { to: '/admin/branding',      label: 'Branding',      icon: 'palette',             minRole: 'branding' },
      { to: '/admin/localization',  label: 'Localization',  icon: 'translate',           minRole: 'branding' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/admin/users',     label: 'Users',     icon: 'group',        minRole: 'admin' },
      { to: '/admin/vault',     label: 'Vault',     icon: 'shield_lock',  minRole: 'admin' },
      { to: '/admin/audit-log', label: 'Audit Log', icon: 'policy',       minRole: 'admin' },
      { to: '/admin/backups',   label: 'Backups',   icon: 'backup',       minRole: 'admin' },
      { to: '/admin/system-health', label: 'System Health', icon: 'monitor_heart', minRole: 'admin' },
    ],
  },
]

const ICON_STYLE = { fontSize: '20px' }

function Brand() {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <img src={'/admin/icon.png'} alt="BetterStatusPage" style={{ width: '40px', height: '40px', objectFit: 'contain', flexShrink: 0 }} />
      <div className="min-w-0">
        <p className="font-headline font-bold text-base leading-none" style={{ color: 'var(--m3-on-surface)' }}>
          Admin Console
        </p>
        <p className="text-xs leading-none mt-1" style={{ color: 'var(--m3-secondary)' }}>
          Reliability Engineering
        </p>
      </div>
    </div>
  )
}

interface NavContentProps {
  sections: NavSection[]
  isDark: boolean
  onToggleDark: () => void
  onLogout: () => void
}

/** Section links plus the Settings / theme / logout footer, shared by the desktop sidebar and the mobile drawer. */
function NavContent({ sections, isDark, onToggleDark, onLogout }: NavContentProps) {
  return (
    <>
      <nav aria-label="Main" className="flex-1 px-3 overflow-y-auto pb-2">
        {sections.map((section, si) => (
          <div key={section.label} className={si > 0 ? 'mt-4' : ''}>
            <p
              className="px-4 pb-1 font-mono uppercase tracking-widest"
              style={{ fontSize: '10px', color: 'var(--m3-outline)', letterSpacing: '0.1em' }}
            >
              {section.label}
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === '/admin/'} className="admin-nav-item">
                  {({ isActive }) => (
                    <>
                      <span
                        aria-hidden="true" className="material-symbols-outlined flex-shrink-0"
                        style={{ ...ICON_STYLE, fontVariationSettings: isActive ? "'FILL' 1" : "'FILL' 0" }}
                      >
                        {item.icon}
                      </span>
                      <span className="font-sans">{item.label}</span>
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-3 pb-4 pt-4 space-y-0.5" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
        <Link to="/admin/settings" className="admin-nav-item">
          <span aria-hidden="true" className="material-symbols-outlined flex-shrink-0" style={ICON_STYLE}>manage_accounts</span>
          <span className="font-sans">Settings</span>
        </Link>

        <button type="button" onClick={onToggleDark} className="admin-nav-item">
          <span aria-hidden="true" className="material-symbols-outlined flex-shrink-0" style={ICON_STYLE}>
            {isDark ? 'light_mode' : 'dark_mode'}
          </span>
          <span className="font-sans">{isDark ? 'Light Mode' : 'Dark Mode'}</span>
        </button>

        <button type="button" onClick={onLogout} className="admin-nav-item admin-nav-danger">
          <span aria-hidden="true" className="material-symbols-outlined flex-shrink-0" style={ICON_STYLE}>logout</span>
          <span className="font-sans">Logout</span>
        </button>
      </div>
    </>
  )
}

interface MobileDrawerProps extends NavContentProps {
  onClose: () => void
  returnFocusRef: RefObject<HTMLButtonElement | null>
}

function MobileDrawer({ onClose, returnFocusRef, ...nav }: MobileDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const returnTo = returnFocusRef.current
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      returnTo?.focus()
    }
  }, [onClose, returnFocusRef])

  return (
    <div className="md:hidden fixed inset-0 z-50">
      <div data-testid="nav-drawer-overlay" className="admin-drawer-overlay absolute inset-0" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose} />
      <div
        id="admin-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="admin-drawer-panel absolute inset-y-0 left-0 flex flex-col w-72 max-w-[85vw]"
        style={{ background: 'var(--m3-surface-container-low)', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-4 mb-4">
          <Brand />
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close navigation" className="btn-icon">
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
          </button>
        </div>
        <NavContent {...nav} />
      </div>
    </div>
  )
}

export default function Layout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [isDark, toggleDark] = useDarkMode()
  const currentUser = getCurrentUser()
  const userRank = ROLE_RANK[currentUser?.role ?? ''] ?? 0
  // The drawer remembers the path it was opened on, so navigating anywhere closes it without an effect.
  const [drawerPath, setDrawerPath] = useState<string | null>(null)
  const drawerOpen = drawerPath === location.pathname
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const closeDrawer = useCallback(() => setDrawerPath(null), [])

  const navSections = ALL_SECTIONS
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => userRank >= (ROLE_RANK[item.minRole] ?? 99)),
    }))
    .filter((section) => section.items.length > 0)

  async function handleLogout() {
    try { await api.post('/auth/logout') } catch { /* local logout still proceeds */ }
    clearSession()
    navigate('/admin/login')
  }

  const nav: NavContentProps = { sections: navSections, isDark, onToggleDark: toggleDark, onLogout: () => void handleLogout() }

  return (
    <div className="flex flex-col md:flex-row h-screen" style={{ background: 'var(--m3-surface-container-low)' }}>
      {/* Mobile top bar */}
      <header
        className="md:hidden flex items-center justify-between gap-3 px-4 py-3 flex-shrink-0"
        style={{ background: 'var(--m3-surface-container-low)', borderBottom: '1px solid var(--m3-outline-variant)' }}
      >
        <Brand />
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setDrawerPath(location.pathname)}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          aria-controls="admin-nav-drawer"
          className="btn-icon"
        >
          <span aria-hidden="true" className="material-symbols-outlined">menu</span>
        </button>
      </header>

      {drawerOpen && <MobileDrawer {...nav} onClose={closeDrawer} returnFocusRef={menuButtonRef} />}

      {/* Sidebar */}
      <aside
        className="hidden md:flex flex-col h-screen w-64 sticky top-0 flex-shrink-0"
        style={{ background: 'var(--m3-surface-container-low)' }}
      >
        <div className="mb-6 px-4 pt-5">
          <Brand />
        </div>
        <NavContent {...nav} />
      </aside>

      {/* Main */}
      <main className="flex-1 min-h-0 min-w-0 overflow-auto" style={{ background: 'var(--m3-surface-container-low)' }}>
        <Outlet />
      </main>
    </div>
  )
}
