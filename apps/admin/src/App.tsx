import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { lazy, Suspense, useState, useEffect } from 'react'
import { api, clearSession, getCurrentUser, isViewer, mustChangePassword, setSession, type AuthUser } from './api/client'
import { navigation, statusPageUrl } from './navigation'
import Layout from './components/Layout'
import LoginPage from './pages/Login'
import SetupPage from './pages/Setup'
const DashboardPage = lazy(() => import('./pages/Dashboard'))
const MonitorsPage = lazy(() => import('./pages/Monitors'))
const IncidentsPage = lazy(() => import('./pages/Incidents'))
const BuilderPage = lazy(() => import('./pages/Builder'))
const BrandingPage = lazy(() => import('./pages/Branding'))
import ChangePasswordPage from './pages/ChangePassword'
const UsersPage = lazy(() => import('./pages/Users'))
const SsoTestResultPage = lazy(() => import('./pages/SsoTestResult'))
import SsoConfirmPage from './pages/SsoConfirm'
const SettingsPage = lazy(() => import('./pages/Settings'))
const LocalizationPage = lazy(() => import('./pages/Localization'))
const VaultPage = lazy(() => import('./pages/Vault'))
const NotificationsPage = lazy(() => import('./pages/Notifications'))
const SubscribersPage = lazy(() => import('./pages/Subscribers'))
const MaintenancePage = lazy(() => import('./pages/Maintenance'))
const AuditLogPage = lazy(() => import('./pages/AuditLog'))
const BackupsPage = lazy(() => import('./pages/Backups'))
const SystemHealthPage = lazy(() => import('./pages/SystemHealth'))
const ReportsPage = lazy(() => import('./pages/Reports'))
const DeliveryHistoryPage = lazy(() => import('./pages/DeliveryHistory'))
const DeliveryHistoryRedirect = lazy(() => import('./pages/DeliveryHistory').then((m) => ({ default: m.DeliveryHistoryRedirect })))

const ROLE_RANK: Record<string, number> = { admin: 3, operator: 2, branding: 1 }

function roleHome(role?: string) {
  return role === 'branding' ? '/admin/branding' : '/admin/'
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'authenticated' | 'anonymous' | 'viewer'>('checking')

  useEffect(() => {
    api.get<AuthUser>('/auth/session')
      .then((user) => { setSession(user); setState(isViewer(user) ? 'viewer' : 'authenticated') })
      .catch(() => { clearSession(); setState('anonymous') })
  }, [])

  useEffect(() => {
    // A viewer may only view the status page, so the console sends them there.
    if (state === 'viewer') navigation.assign(statusPageUrl())
  }, [state])

  if (state === 'checking' || state === 'viewer') return null
  if (state === 'anonymous') return <Navigate to="/admin/login" replace />
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
      <Suspense fallback={null}>
      <Routes>
        {/* Setup wizard — only accessible when no users exist */}
        <Route path="/admin/setup" element={<SetupPage />} />
        {/* SSO confirmation popup landing: outside the auth guards, it only reports the outcome and closes. */}
        <Route path="/admin/sso-confirm" element={<SsoConfirmPage />} />

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
          <Route path="maintenance" element={<RequireRole minRole="operator"><MaintenancePage /></RequireRole>} />
          <Route path="reports" element={<RequireRole minRole="operator"><ReportsPage /></RequireRole>} />
          <Route path="builder"   element={<RequireRole minRole="branding"><BuilderPage /></RequireRole>} />
          <Route path="branding"  element={<RequireRole minRole="branding"><BrandingPage /></RequireRole>} />
          <Route path="notifications" element={<RequireRole minRole="operator"><NotificationsPage /></RequireRole>} />
          <Route path="delivery-history" element={<RequireRole minRole="operator"><DeliveryHistoryPage /></RequireRole>} />
          <Route path="notifications/history" element={<DeliveryHistoryRedirect tab="notifications" />} />
          <Route path="subscribers" element={<RequireRole minRole="operator"><SubscribersPage /></RequireRole>} />
          <Route path="subscribers/history" element={<DeliveryHistoryRedirect tab="subscribers" />} />
          <Route path="users"     element={<RequireRole minRole="admin"><UsersPage /></RequireRole>} />
          <Route path="sso-test"  element={<RequireRole minRole="admin"><SsoTestResultPage /></RequireRole>} />
          <Route path="vault"      element={<RequireRole minRole="admin"><VaultPage /></RequireRole>} />
          <Route path="audit-log" element={<RequireRole minRole="admin"><AuditLogPage /></RequireRole>} />
          <Route path="backups" element={<RequireRole minRole="admin"><BackupsPage /></RequireRole>} />
          <Route path="system-health" element={<RequireRole minRole="admin"><SystemHealthPage /></RequireRole>} />
          <Route path="settings"       element={<RequireRole minRole="branding"><SettingsPage /></RequireRole>} />
          <Route path="localization"   element={<RequireRole minRole="branding"><LocalizationPage /></RequireRole>} />
        </Route>
        <Route path="*" element={<Navigate to="/admin/" replace />} />
      </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
