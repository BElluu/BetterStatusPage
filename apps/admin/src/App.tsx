import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { isAuthenticated } from './api/client'
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

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin/login" element={<LoginPage />} />
        <Route
          path="/admin/*"
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="monitors" element={<MonitorsPage />} />
          <Route path="incidents" element={<IncidentsPage />} />
          <Route path="builder" element={<BuilderPage />} />
          <Route path="branding" element={<BrandingPage />} />
          <Route path="change-password" element={<ChangePasswordPage />} />
          <Route path="users" element={<UsersPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/admin/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
