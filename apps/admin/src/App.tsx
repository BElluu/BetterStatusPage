import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import {
  BackupsPage, ChangePasswordPage, ErrorBoundary, LoadingState, RequireAuth, RequirePasswordChanged, SettingsPage, SetupGate, SetupPage,
  SsoConfirmPage, SsoTestResultPage, VaultPage, createRoleGuard,
} from '@better-kit/ui'
import { getCurrentUser } from './api/client'
import Layout from './components/Layout'
import LoginPage from './pages/Login'
const DashboardPage = lazy(() => import('./pages/Dashboard'))
const MonitorsPage = lazy(() => import('./pages/Monitors'))
const MonitorDetailPage = lazy(() => import('./pages/MonitorDetail'))
const IncidentsPage = lazy(() => import('./pages/Incidents'))
const BuilderPage = lazy(() => import('./pages/Builder'))
const BrandingPage = lazy(() => import('./pages/Branding'))
const UsersPage = lazy(() => import('./pages/Users'))
const LocalizationPage = lazy(() => import('./pages/Localization'))
const NotificationsPage = lazy(() => import('./pages/Notifications'))
const ActionsPage = lazy(() => import('./pages/Actions'))
const SubscribersPage = lazy(() => import('./pages/Subscribers'))
const MaintenancePage = lazy(() => import('./pages/Maintenance'))
const ApiTokensPage = lazy(() => import('./pages/ApiTokens'))
const ImportPage = lazy(() => import('./pages/Import'))
const StaticFallbackPage = lazy(() => import('./pages/StaticFallback'))
const AuditLogPage = lazy(() => import('./pages/AuditLog'))
const SystemHealthPage = lazy(() => import('./pages/SystemHealth'))
const ReportsPage = lazy(() => import('./pages/Reports'))
const DeliveryHistoryPage = lazy(() => import('./pages/DeliveryHistory'))
const DeliveryHistoryRedirect = lazy(() => import('./pages/DeliveryHistory').then((m) => ({ default: m.DeliveryHistoryRedirect })))

const ROLE_RANK: Record<string, number> = { admin: 3, operator: 2, branding: 1 }

function roleHome(role?: string) {
  return role === 'branding' ? '/admin/branding' : '/admin/'
}

const RequireRole = createRoleGuard({ roleRank: ROLE_RANK, homeOf: roleHome })

function RoleHome() {
  const user = getCurrentUser()
  if (user?.role === 'branding') return <Navigate to="/admin/branding" replace />
  return <DashboardPage />
}

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
      <Suspense fallback={<LoadingState />}>
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
          <Route path="monitors/:id" element={<RequireRole minRole="operator"><MonitorDetailPage /></RequireRole>} />
          <Route path="incidents" element={<RequireRole minRole="operator"><IncidentsPage /></RequireRole>} />
          <Route path="maintenance" element={<RequireRole minRole="operator"><MaintenancePage /></RequireRole>} />
          <Route path="reports" element={<RequireRole minRole="operator"><ReportsPage /></RequireRole>} />
          <Route path="builder"   element={<RequireRole minRole="branding"><BuilderPage /></RequireRole>} />
          <Route path="branding"  element={<RequireRole minRole="branding"><BrandingPage /></RequireRole>} />
          <Route path="notifications" element={<RequireRole minRole="operator"><NotificationsPage /></RequireRole>} />
          <Route path="actions" element={<RequireRole minRole="admin"><ActionsPage /></RequireRole>} />
          <Route path="delivery-history" element={<RequireRole minRole="operator"><DeliveryHistoryPage /></RequireRole>} />
          <Route path="notifications/history" element={<DeliveryHistoryRedirect tab="notifications" />} />
          <Route path="subscribers" element={<RequireRole minRole="operator"><SubscribersPage /></RequireRole>} />
          <Route path="subscribers/history" element={<DeliveryHistoryRedirect tab="subscribers" />} />
          <Route path="users"     element={<RequireRole minRole="admin"><UsersPage /></RequireRole>} />
          <Route path="sso-test"  element={<RequireRole minRole="admin"><SsoTestResultPage /></RequireRole>} />
          <Route path="vault"      element={<RequireRole minRole="admin"><VaultPage /></RequireRole>} />
          <Route path="import" element={<RequireRole minRole="operator"><ImportPage /></RequireRole>} />
          <Route path="api-tokens" element={<RequireRole minRole="admin"><ApiTokensPage /></RequireRole>} />
          <Route path="static-fallback" element={<RequireRole minRole="admin"><StaticFallbackPage /></RequireRole>} />
          <Route path="audit-log" element={<RequireRole minRole="admin"><AuditLogPage /></RequireRole>} />
          <Route path="backups" element={<RequireRole minRole="admin"><BackupsPage /></RequireRole>} />
          <Route path="system-health" element={<RequireRole minRole="admin"><SystemHealthPage /></RequireRole>} />
          <Route path="settings"       element={<RequireRole minRole="branding"><SettingsPage /></RequireRole>} />
          <Route path="localization"   element={<RequireRole minRole="branding"><LocalizationPage /></RequireRole>} />
        </Route>
        <Route path="*" element={<Navigate to="/admin/" replace />} />
      </Routes>
      </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  )
}
