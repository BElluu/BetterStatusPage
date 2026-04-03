import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { clearToken } from '../api/client'

const navItems = [
  { to: '/admin/', label: 'Dashboard', icon: NavIconDashboard },
  { to: '/admin/monitors', label: 'Monitors', icon: NavIconMonitors },
  { to: '/admin/incidents', label: 'Incidents', icon: NavIconIncidents },
  { to: '/admin/builder', label: 'Page Builder', icon: NavIconBuilder },
  { to: '/admin/branding', label: 'Branding', icon: NavIconBranding },
]

export default function Layout() {
  const navigate = useNavigate()

  function handleLogout() {
    clearToken()
    navigate('/admin/login')
  }

  return (
    <div className="flex h-screen" style={{ background: 'var(--sig-bg)' }}>
      {/* Sidebar */}
      <aside
        className="w-52 flex flex-col flex-shrink-0"
        style={{ background: 'var(--sig-surface)', borderRight: '1px solid var(--sig-border)' }}
      >
        {/* Brand */}
        <div className="px-5 py-5" style={{ borderBottom: '1px solid var(--sig-border)' }}>
          <div className="flex items-center gap-2.5">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: 'var(--sig-teal-glow)', border: '1px solid rgba(0,212,175,0.3)' }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="2.5" fill="#00d4af" />
                <circle cx="7" cy="7" r="5.5" stroke="#00d4af" strokeWidth="1" strokeOpacity="0.4" fill="none" />
              </svg>
            </div>
            <div>
              <p className="font-display font-bold text-sm leading-none" style={{ color: 'var(--sig-text)' }}>
                BetterStatus
              </p>
              <p className="text-xs leading-none mt-1" style={{ color: 'var(--sig-text-muted)' }}>
                Admin
              </p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2 space-y-0.5">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/admin/'}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-all group ${
                    isActive ? 'sig-nav-active' : 'sig-nav-idle'
                  }`
                }
                style={({ isActive }) => isActive
                  ? {
                      color: 'var(--sig-teal)',
                      background: 'var(--sig-teal-glow)',
                      borderLeft: '2px solid var(--sig-teal)',
                      paddingLeft: '10px',
                    }
                  : {
                      color: 'var(--sig-text-muted)',
                      borderLeft: '2px solid transparent',
                    }
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon active={isActive} />
                    <span className="font-medium">{item.label}</span>
                  </>
                )}
              </NavLink>
            )
          })}
        </nav>

        {/* Logout */}
        <div className="px-2 pb-3" style={{ borderTop: '1px solid var(--sig-border)' }}>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors"
            style={{ color: 'var(--sig-text-muted)', borderLeft: '2px solid transparent' }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--sig-red)'
              ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,77,106,0.08)'
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--sig-text-muted)'
              ;(e.currentTarget as HTMLButtonElement).style.background = ''
            }}
          >
            <NavIconLogout active={false} />
            <span className="font-medium">Logout</span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}

/* ── Nav Icons ───────────────────────────────────────────────────────── */
function NavIconDashboard({ active }: { active: boolean }) {
  const c = active ? '#00d4af' : '#5a6a8a'
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <rect x="1" y="1" width="6" height="6" rx="1.5" stroke={c} strokeWidth="1.3" fill={active ? 'rgba(0,212,175,0.12)' : 'none'} />
      <rect x="9" y="1" width="6" height="6" rx="1.5" stroke={c} strokeWidth="1.3" fill={active ? 'rgba(0,212,175,0.12)' : 'none'} />
      <rect x="1" y="9" width="6" height="6" rx="1.5" stroke={c} strokeWidth="1.3" fill={active ? 'rgba(0,212,175,0.12)' : 'none'} />
      <rect x="9" y="9" width="6" height="6" rx="1.5" stroke={c} strokeWidth="1.3" fill={active ? 'rgba(0,212,175,0.12)' : 'none'} />
    </svg>
  )
}

function NavIconMonitors({ active }: { active: boolean }) {
  const c = active ? '#00d4af' : '#5a6a8a'
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <circle cx="8" cy="8" r="6.5" stroke={c} strokeWidth="1.3" />
      <circle cx="8" cy="8" r="2.5" fill={c} opacity={active ? 1 : 0.5} />
    </svg>
  )
}

function NavIconIncidents({ active }: { active: boolean }) {
  const c = active ? '#00d4af' : '#5a6a8a'
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <path d="M8 2L14 13H2L8 2Z" stroke={c} strokeWidth="1.3" strokeLinejoin="round" fill={active ? 'rgba(0,212,175,0.1)' : 'none'} />
      <line x1="8" y1="6" x2="8" y2="9.5" stroke={c} strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r="0.7" fill={c} />
    </svg>
  )
}

function NavIconBuilder({ active }: { active: boolean }) {
  const c = active ? '#00d4af' : '#5a6a8a'
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <rect x="1" y="1" width="14" height="10" rx="1.5" stroke={c} strokeWidth="1.3" fill={active ? 'rgba(0,212,175,0.08)' : 'none'} />
      <line x1="6" y1="1" x2="6" y2="11" stroke={c} strokeWidth="1.3" />
      <line x1="1" y1="6" x2="15" y2="6" stroke={c} strokeWidth="1.3" />
      <line x1="4" y1="14" x2="12" y2="14" stroke={c} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function NavIconBranding({ active }: { active: boolean }) {
  const c = active ? '#00d4af' : '#5a6a8a'
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <circle cx="5" cy="5" r="2.5" stroke={c} strokeWidth="1.3" fill={active ? 'rgba(0,212,175,0.15)' : 'none'} />
      <circle cx="11" cy="5" r="2.5" stroke={c} strokeWidth="1.3" fill={active ? 'rgba(245,166,35,0.15)' : 'none'} />
      <circle cx="8" cy="11" r="2.5" stroke={c} strokeWidth="1.3" fill={active ? 'rgba(255,77,106,0.15)' : 'none'} />
    </svg>
  )
}

function NavIconLogout({ active }: { active: boolean }) {
  const c = active ? '#ff4d6a' : 'currentColor'
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3" stroke={c} strokeWidth="1.3" strokeLinecap="round" />
      <path d="M10 5l3 3-3 3" stroke={c} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="13" y1="8" x2="6" y2="8" stroke={c} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
