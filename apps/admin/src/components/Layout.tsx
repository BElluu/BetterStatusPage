import { Outlet, NavLink, useNavigate, Link } from 'react-router-dom'
import { api, clearSession, getCurrentUser } from '../api/client'
import { useDarkMode } from '../hooks/useDarkMode'

// role hierarchy: admin > operator > branding
const ROLE_RANK: Record<string, number> = { admin: 3, operator: 2, branding: 1 }

export default function Layout() {
  const navigate = useNavigate()
  const [isDark, toggleDark] = useDarkMode()
  const currentUser = getCurrentUser()
  const userRank = ROLE_RANK[currentUser?.role ?? ''] ?? 0
  const hoverBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)'

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

  return (
    <div className="flex h-screen" style={{ background: 'var(--m3-surface-container-low)' }}>
      {/* Sidebar */}
      <aside
        className="hidden md:flex flex-col h-screen w-64 sticky top-0 flex-shrink-0"
        style={{ background: 'var(--m3-surface-container-low)' }}
      >
        {/* Brand */}
        <div className="mb-6 px-4 pt-5">
          <div className="flex items-center gap-3">
            <img src={'/admin/icon.png'} alt="BetterStatusPage" style={{ width: '40px', height: '40px', objectFit: 'contain', flexShrink: 0 }} />
            <div>
              <p className="font-headline font-bold text-base leading-none" style={{ color: 'var(--m3-on-surface)' }}>
                Admin Console
              </p>
              <p className="text-xs leading-none mt-1" style={{ color: 'var(--m3-secondary)' }}>
                Reliability Engineering
              </p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 overflow-y-auto pb-2">
          {navSections.map((section, si) => (
            <div key={section.label} className={si > 0 ? 'mt-4' : ''}>
              <p
                className="px-4 pb-1 font-mono uppercase tracking-widest"
                style={{ fontSize: '10px', color: 'var(--m3-outline)', letterSpacing: '0.1em' }}
              >
                {section.label}
              </p>
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/admin/'}
                    className="flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition-all duration-200 hover:translate-x-1"
                    style={({ isActive }) => isActive
                      ? {
                          background: 'var(--m3-surface-container-lowest)',
                          color: 'var(--m3-on-surface)',
                          fontWeight: 600,
                          boxShadow: '0 1px 4px rgba(19,27,46,0.08)',
                        }
                      : {
                          color: 'var(--m3-secondary)',
                        }
                    }
                    onMouseEnter={(e) => {
                      const el = e.currentTarget
                      if (!el.style.boxShadow || el.style.boxShadow === 'none') {
                        el.style.background = hoverBg
                        el.style.color = 'var(--m3-on-surface)'
                      }
                    }}
                    onMouseLeave={(e) => {
                      const el = e.currentTarget
                      if (!el.style.boxShadow || el.style.boxShadow === 'none') {
                        el.style.background = ''
                        el.style.color = 'var(--m3-secondary)'
                      }
                    }}
                  >
                    {({ isActive }) => (
                      <>
                        <span
                          className="material-symbols-outlined flex-shrink-0"
                          style={{
                            fontSize: '20px',
                            fontVariationSettings: isActive ? "'FILL' 1" : "'FILL' 0",
                          }}
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

        {/* Bottom */}
        <div className="px-3 pb-4 pt-4 space-y-0.5" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
          {/* Settings */}
          <Link
            to="/admin/settings"
            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition-all hover:translate-x-1"
            style={{ color: 'var(--m3-secondary)' }}
            onMouseEnter={(e) => {
              ;(e.currentTarget).style.background = hoverBg
              ;(e.currentTarget).style.color = 'var(--m3-on-surface)'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget).style.background = ''
              ;(e.currentTarget).style.color = 'var(--m3-secondary)'
            }}
          >
            <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: '20px' }}>manage_accounts</span>
            <span className="font-sans">Settings</span>
          </Link>

          {/* Dark mode toggle */}
          <button
            onClick={toggleDark}
            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition-all hover:translate-x-1"
            style={{ color: 'var(--m3-secondary)' }}
            onMouseEnter={(e) => {
              ;(e.currentTarget).style.background = hoverBg
              ;(e.currentTarget).style.color = 'var(--m3-on-surface)'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget).style.background = ''
              ;(e.currentTarget).style.color = 'var(--m3-secondary)'
            }}
          >
            <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: '20px' }}>
              {isDark ? 'light_mode' : 'dark_mode'}
            </span>
            <span className="font-sans">{isDark ? 'Light Mode' : 'Dark Mode'}</span>
          </button>

          {/* Logout */}
          <button
            onClick={() => void handleLogout()}
            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition-all hover:translate-x-1"
            style={{ color: 'var(--m3-secondary)' }}
            onMouseEnter={(e) => {
              ;(e.currentTarget).style.background = 'var(--m3-error-container)'
              ;(e.currentTarget).style.color = 'var(--m3-on-error-container)'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget).style.background = ''
              ;(e.currentTarget).style.color = 'var(--m3-secondary)'
            }}
          >
            <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: '20px' }}>logout</span>
            <span className="font-sans">Logout</span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto" style={{ background: 'var(--m3-surface-container-low)' }}>
        <Outlet />
      </main>
    </div>
  )
}
