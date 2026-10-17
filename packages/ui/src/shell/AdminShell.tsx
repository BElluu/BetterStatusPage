import { Fragment, useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Outlet, NavLink, useNavigate, useLocation, Link } from 'react-router-dom'
import { api, clearSession, getCurrentUser } from '../api/client'
import { WhatsNew, markWhatsNewSeen, pendingWhatsNew } from '../components/WhatsNew'
import { useDarkMode } from '../hooks/useDarkMode'
import { useDatePrefs } from '../lib/dateFormat'

export interface NavItem {
  to: string
  label: string
  icon: string
  /** The lowest role that sees the item (see `roleRank`). */
  minRole: string
}

export interface NavSection { label: string; items: NavItem[] }

/** A link below the sections that leaves the interface (the public page, the documentation). */
export interface ExternalLink { label: string; icon: string; href: () => string }

export interface AdminShellConfig {
  sections: NavSection[]
  /** Roles from the lowest to the highest rank: a user sees an item when their rank reaches the item's `minRole`. */
  roleRank: Readonly<Record<string, number>>
  brand: { iconUrl: string; name: string; title: string; subtitle: string }
  /** The page the first item leads to: it is highlighted only when it is exactly the current one. */
  homePath: string
  settingsPath: string
  loginPath: string
  externalLinks: readonly ExternalLink[]
  /** The release notes shown once to a user who last saw an older version. */
  whatsNew: { changelog: string; version: string; docsUrl: string }
}

const ICON_STYLE = { fontSize: '20px' }

function Brand({ brand }: { brand: AdminShellConfig['brand'] }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <img src={brand.iconUrl} alt={brand.name} style={{ width: '40px', height: '40px', objectFit: 'contain', flexShrink: 0 }} />
      <div className="min-w-0">
        <p className="font-headline font-bold text-base leading-none" style={{ color: 'var(--m3-on-surface)' }}>
          {brand.title}
        </p>
        <p className="text-xs leading-none mt-1" style={{ color: 'var(--m3-secondary)' }}>
          {brand.subtitle}
        </p>
      </div>
    </div>
  )
}

interface NavContentProps {
  config: AdminShellConfig
  sections: NavSection[]
  isDark: boolean
  onToggleDark: () => void
  onLogout: () => void
}

/** Section links plus the Settings / theme / logout footer, shared by the desktop sidebar and the mobile drawer. */
function NavContent({ config, sections, isDark, onToggleDark, onLogout }: NavContentProps) {
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
                <NavLink key={item.to} to={item.to} end={item.to === config.homePath} className="admin-nav-item">
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
        {config.externalLinks.map((link) => (
          <a key={link.label} href={link.href()} target="_blank" rel="noopener" className="admin-nav-item">
            <span aria-hidden="true" className="material-symbols-outlined flex-shrink-0" style={ICON_STYLE}>{link.icon}</span>
            <span className="font-sans">{link.label}</span>
          </a>
        ))}

        <Link to={config.settingsPath} className="admin-nav-item">
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
          <Brand brand={nav.config.brand} />
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close navigation" className="btn-icon">
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
          </button>
        </div>
        <NavContent {...nav} />
      </div>
    </div>
  )
}

/**
 * The signed-in shell of an admin interface: a sidebar (a drawer on a phone) with the sections the user's role may see,
 * the footer links, the theme switch and logout, and the page below it. The sections, roles, brand and links are the
 * application's; the page is whatever the router renders in the `Outlet`.
 */
export function createAdminShell(config: AdminShellConfig) {
  return function AdminShell() {
    const navigate = useNavigate()
    const location = useLocation()
    const [isDark, toggleDark] = useDarkMode()
    const datePrefs = useDatePrefs()
    const currentUser = getCurrentUser()
    const userRank = config.roleRank[currentUser?.role ?? ''] ?? 0
    // The drawer remembers the path it was opened on, so navigating anywhere closes it without an effect.
    const [drawerPath, setDrawerPath] = useState<string | null>(null)
    const drawerOpen = drawerPath === location.pathname
    const menuButtonRef = useRef<HTMLButtonElement>(null)
    const closeDrawer = useCallback(() => setDrawerPath(null), [])

    const navSections = config.sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => userRank >= (config.roleRank[item.minRole] ?? 99)),
      }))
      .filter((section) => section.items.length > 0)

    const { changelog, version, docsUrl } = config.whatsNew
    const userId = currentUser?.userId
    const [whatsNew, setWhatsNew] = useState(() => userId !== undefined ? pendingWhatsNew(userId, changelog, version) : [])
    const closeWhatsNew = useCallback(() => {
      setWhatsNew([])
      if (userId !== undefined) markWhatsNewSeen(userId, version)
    }, [userId, version])

    async function handleLogout() {
      try { await api.post('/auth/logout') } catch { /* local logout still proceeds */ }
      clearSession()
      navigate(config.loginPath)
    }

    const nav: NavContentProps = { config, sections: navSections, isDark, onToggleDark: toggleDark, onLogout: () => void handleLogout() }

    return (
      <div className="flex flex-col md:flex-row h-screen" style={{ background: 'var(--m3-surface-container-low)' }}>
        {/* Mobile top bar */}
        <header
          className="md:hidden flex items-center justify-between gap-3 px-4 py-3 flex-shrink-0"
          style={{ background: 'var(--m3-surface-container-low)', borderBottom: '1px solid var(--m3-outline-variant)' }}
        >
          <Brand brand={config.brand} />
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

        {whatsNew.length > 0 && <WhatsNew releases={whatsNew} docsUrl={docsUrl} onClose={closeWhatsNew} />}

        {drawerOpen && <MobileDrawer {...nav} onClose={closeDrawer} returnFocusRef={menuButtonRef} />}

        {/* Sidebar */}
        <aside
          className="hidden md:flex flex-col h-screen w-64 sticky top-0 flex-shrink-0"
          style={{ background: 'var(--m3-surface-container-low)' }}
        >
          <div className="mb-6 px-4 pt-5">
            <Brand brand={config.brand} />
          </div>
          <NavContent {...nav} />
        </aside>

        {/* Main */}
        <main className="flex-1 min-h-0 min-w-0 overflow-auto" style={{ background: 'var(--m3-surface-container-low)' }}>
          {/* Remount the page when the date format changes so every formatted date is recomputed. */}
          <Fragment key={`${datePrefs.date}-${datePrefs.time}`}><Outlet /></Fragment>
        </main>
      </div>
    )
  }
}
