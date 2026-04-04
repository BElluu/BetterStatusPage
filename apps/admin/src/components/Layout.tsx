import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { clearToken } from '../api/client'
import { useDarkMode } from '../hooks/useDarkMode'

const navItems = [
  { to: '/admin/', label: 'Dashboard', icon: 'dashboard' },
  { to: '/admin/monitors', label: 'Monitors', icon: 'radio_button_checked' },
  { to: '/admin/incidents', label: 'Incidents', icon: 'warning' },
  { to: '/admin/builder', label: 'Page Builder', icon: 'dashboard_customize' },
  { to: '/admin/branding', label: 'Branding', icon: 'palette' },
]

export default function Layout() {
  const navigate = useNavigate()
  const [isDark, toggleDark] = useDarkMode()

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
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: 'var(--m3-on-surface)' }}
            >
              <span className="material-symbols-outlined text-xl" style={{ color: 'var(--m3-surface)', fontSize: '20px' }}>
                architecture
              </span>
            </div>
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

        {/* New Incident CTA */}
        <div className="px-4 mb-5">
          <button
            onClick={() => navigate('/admin/incidents')}
            className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-headline font-bold text-sm transition-all active:scale-[0.98]"
            style={{ background: 'var(--m3-on-surface)', color: 'var(--m3-surface)' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add_circle</span>
            New Incident
          </button>
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
            <span className="font-sans">{isDark ? 'Light Mode' : 'Dark Mode'}</span>
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
