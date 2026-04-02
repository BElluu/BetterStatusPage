import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { clearToken } from '../api/client'

const navItems = [
  { to: '/admin/', label: 'Dashboard', icon: '◈' },
  { to: '/admin/monitors', label: 'Monitors', icon: '◉' },
  { to: '/admin/incidents', label: 'Incidents', icon: '⚠' },
  { to: '/admin/builder', label: 'Page Builder', icon: '⊞' },
  { to: '/admin/branding', label: 'Branding', icon: '◈' },
]

export default function Layout() {
  const navigate = useNavigate()

  function handleLogout() {
    clearToken()
    navigate('/admin/login')
  }

  return (
    <div className="flex h-screen bg-slate-950">
      {/* Sidebar */}
      <aside className="w-60 flex flex-col bg-slate-900 border-r border-slate-800">
        <div className="p-4 border-b border-slate-800">
          <h1 className="text-lg font-bold text-white">Status Admin</h1>
          <p className="text-xs text-slate-500 mt-0.5">Management Panel</p>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/admin/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`
              }
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="p-3 border-t border-slate-800">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <span>⎋</span>
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
