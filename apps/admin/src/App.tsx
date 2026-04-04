import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { isAuthenticated, mustChangePassword } from './api/client'
import Layout from './components/Layout'
import LoginPage from './pages/Login'
import DashboardPage from './pages/Dashboard'
import MonitorsPage from './pages/Monitors'
import IncidentsPage from './pages/Incidents'
import BuilderPage from './pages/Builder'
import BrandingPage from './pages/Branding'
import ChangePasswordPage from './pages/ChangePassword'
import UsersPage from './pages/Users'

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!isAuthenticated()) {
    return <Navigate to="/admin/login" replace />
  }
  return <>{children}</>
}

function RequirePasswordChanged({ children }: { children: React.ReactNode }) {
  if (mustChangePassword()) {
    return <Navigate to="/admin/change-password" replace />
  }
  return <>{children}</>
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
          <Route index element={<DashboardPage />} />
          <Route path="monitors" element={<MonitorsPage />} />
          <Route path="incidents" element={<IncidentsPage />} />
          <Route path="builder" element={<BuilderPage />} />
          <Route path="branding" element={<BrandingPage />} />
          <Route path="users" element={<UsersPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/admin/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
