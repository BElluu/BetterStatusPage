import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { isAuthenticated, mustChangePassword, getCurrentUser } from './api/client'
import Layout from './components/Layout'
import LoginPage from './pages/Login'
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

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin/login" element={<LoginPage />} />
        {/* Change-password: requires token but no layout, no password-change guard */}
        <Route
          path="/admin/change-password"
          element={<RequireAuth><ChangePasswordPage /></RequireAuth>}
        />
        {/* All other admin routes: require token + password already changed */}
        <Route
          path="/admin/*"
          element={
            <RequireAuth>
              <RequirePasswordChanged>
                <Layout />
              </RequirePasswordChanged>
            </RequireAuth>
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
