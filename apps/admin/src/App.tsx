import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { isAuthenticated, mustChangePassword, getCurrentUser } from './api/client'
import Layout from './components/Layout'
import LoginPage from './pages/Login'
import SetupPage from './pages/Setup'
import DashboardPage from './pages/Dashboard'
import MonitorsPage from './pages/Monitors'
import IncidentsPage from './pages/Incidents'
import BuilderPage from './pages/Builder'
import BrandingPage from './pages/Branding'
import ChangePasswordPage from './pages/ChangePassword'
import UsersPage from './pages/Users'
import SettingsPage from './pages/Settings'

const ROLE_RANK: Record<string, number> = { admin: 3, operator: 2, branding: 1 }

function roleHome(role?: string) {
  return role === 'branding' ? '/admin/branding' : '/admin/'
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!isAuthenticated()) return <Navigate to="/admin/login" replace />
  return <>{children}</>
}

function RequirePasswordChanged({ children }: { children: React.ReactNode }) {
  if (mustChangePassword()) return <Navigate to="/admin/change-password" replace />
  return <>{children}</>
}

function RequireRole({ minRole, children }: { minRole: string; children: React.ReactNode }) {
  const user = getCurrentUser()
  const rank = ROLE_RANK[user?.role ?? ''] ?? 0
  if (rank < (ROLE_RANK[minRole] ?? 99)) return <Navigate to={roleHome(user?.role)} replace />
  return <>{children}</>
}

function RoleHome() {
  const user = getCurrentUser()
  if (user?.role === 'branding') return <Navigate to="/admin/branding" replace />
  return <DashboardPage />
}

/** Checks /api/v1/setup/status and redirects to /admin/setup if first run. */
function SetupGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'loading' | 'setup' | 'ready'>('loading')

  useEffect(() => {
    fetch('/api/v1/setup/status')
      .then((r) => r.json())
      .then((data: { needsSetup: boolean }) => {
        setState(data.needsSetup ? 'setup' : 'ready')
      })
      .catch(() => setState('ready'))
  }, [])

  if (state === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--m3-surface)' }}>
        <div className="flex flex-col items-center gap-4">
          <div
            className="w-10 h-10 rounded-2xl flex items-center justify-center"
            style={{ background: 'var(--m3-primary-fixed)' }}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <circle cx="10" cy="10" r="3.5" fill="var(--m3-primary)" />
              <circle cx="10" cy="10" r="8.5" stroke="var(--m3-primary)" strokeWidth="1.2" strokeOpacity="0.35" fill="none" />
            </svg>
          </div>
          <span className="font-sans text-sm" style={{ color: 'var(--m3-secondary)' }}>Starting…</span>
        </div>
      </div>
    )
  }

  if (state === 'setup') return <Navigate to="/admin/setup" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Setup wizard — only accessible when no users exist */}
        <Route path="/admin/setup" element={<SetupPage />} />

        {/* All other routes go through SetupGate first */}
        <Route
          path="/admin/login"
          element={<SetupGate><LoginPage /></SetupGate>}
        />
        <Route
          path="/admin/change-password"
          element={<SetupGate><RequireAuth><ChangePasswordPage /></RequireAuth></SetupGate>}
        />
        <Route
          path="/admin/*"
          element={
            <SetupGate>
              <RequireAuth>
                <RequirePasswordChanged>
                  <Layout />
                </RequirePasswordChanged>
              </RequireAuth>
            </SetupGate>
          }
        >
          <Route index element={<RoleHome />} />
          <Route path="monitors"  element={<RequireRole minRole="operator"><MonitorsPage /></RequireRole>} />
          <Route path="incidents" element={<RequireRole minRole="operator"><IncidentsPage /></RequireRole>} />
          <Route path="builder"   element={<RequireRole minRole="operator"><BuilderPage /></RequireRole>} />
          <Route path="branding"  element={<RequireRole minRole="branding"><BrandingPage /></RequireRole>} />
          <Route path="users"     element={<RequireRole minRole="admin"><UsersPage /></RequireRole>} />
          <Route path="settings"  element={<RequireRole minRole="branding"><SettingsPage /></RequireRole>} />
        </Route>
        <Route path="*" element={<Navigate to="/admin/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
