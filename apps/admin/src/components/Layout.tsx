import { Outlet, NavLink, useNavigate, Link } from 'react-router-dom'
import { clearToken, getCurrentUser } from '../api/client'
import { useDarkMode } from '../hooks/useDarkMode'
import { useAdminLocale } from '../i18n/LocaleContext'
import { AdminLanguageSwitcher } from './LanguageSwitcher'

// role hierarchy: admin > operator > branding
const ROLE_RANK: Record<string, number> = { admin: 3, operator: 2, branding: 1 }

export default function Layout() {
  const navigate = useNavigate()
  const [isDark, toggleDark] = useDarkMode()
  const currentUser = getCurrentUser()
  const userRank = ROLE_RANK[currentUser?.role ?? ''] ?? 0
  const { t } = useAdminLocale()

  const ALL_NAV = [
    { to: '/admin/',               label: t('nav.dashboard'),    icon: 'dashboard',            minRole: 'operator' },
    { to: '/admin/monitors',       label: t('nav.monitors'),     icon: 'radio_button_checked', minRole: 'operator' },
    { to: '/admin/incidents',      label: t('nav.incidents'),    icon: 'warning',              minRole: 'operator' },
    { to: '/admin/builder',        label: t('nav.pageBuilder'),  icon: 'dashboard_customize',  minRole: 'operator' },
    { to: '/admin/branding',       label: t('nav.branding'),     icon: 'palette',              minRole: 'branding' },
    { to: '/admin/localization',   label: t('nav.localization'), icon: 'translate',            minRole: 'branding' },
    { to: '/admin/users',          label: t('nav.users'),        icon: 'group',                minRole: 'admin'    },
  ]

  const navItems = ALL_NAV.filter((item) => userRank >= (ROLE_RANK[item.minRole] ?? 99))

  function handleLogout() {
    clearToken()
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
        <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/admin/'}
              className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm transition-all duration-200 hover:translate-x-1"
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
                  el.style.background = 'rgba(0,0,0,0.04)'
                  el.style.color = 'var(--m3-on-surface)'
                }
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget
                if (el.style.background === 'rgba(0,0,0,0.04)') {
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
        </nav>

        {/* Bottom */}
        <div className="px-3 pb-4 pt-4 space-y-0.5" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
          {/* Settings */}
          <Link
            to="/admin/settings"
            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition-all hover:translate-x-1"
            style={{ color: 'var(--m3-secondary)' }}
            onMouseEnter={(e) => {
              ;(e.currentTarget).style.background = 'rgba(0,0,0,0.04)'
              ;(e.currentTarget).style.color = 'var(--m3-on-surface)'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget).style.background = ''
              ;(e.currentTarget).style.color = 'var(--m3-secondary)'
            }}
          >
            <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: '20px' }}>manage_accounts</span>
            <span className="font-sans">{t('nav.settings')}</span>
          </Link>

          {/* Language switcher (only when >1 locale) */}
          <AdminLanguageSwitcher />

          {/* Dark mode toggle */}
          <button
            onClick={toggleDark}
            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition-all hover:translate-x-1"
            style={{ color: 'var(--m3-secondary)' }}
            onMouseEnter={(e) => {
              ;(e.currentTarget).style.background = 'rgba(0,0,0,0.04)'
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
            <span className="font-sans">{isDark ? t('nav.lightMode') : t('nav.darkMode')}</span>
          </button>

          {/* Logout */}
          <button
            onClick={handleLogout}
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
            <span className="font-sans">{t('nav.logout')}</span>
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
