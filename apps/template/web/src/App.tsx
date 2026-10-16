import { Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import {
  ApiTokensPage, AuditLogPage, BackupsPage, ChangePasswordPage, LoginPage, RequireAuth, RequirePasswordChanged, SettingsPage, SetupGate,
  SetupPage, SsoConfirmPage, UsersPage, VaultPage, createAdminShell, createRoleGuard, type AuditEntities,
} from '@better-kit/ui'
import { TOKEN_RESOURCES } from '../../src/shared/tokens'
import { uiConfig } from './uiConfig'

const ROLE_RANK = { admin: 2, member: 1 }
const RequireRole = createRoleGuard({ roleRank: ROLE_RANK, homeOf: () => '/' })

const Shell = createAdminShell({
  sections: [
    { label: 'Overview', items: [{ to: '/', label: 'Home', icon: 'home', minRole: 'member' }] },
    {
      label: 'Administration',
      items: [
        { to: '/users', label: 'Users', icon: 'group', minRole: 'admin' },
        { to: '/vault', label: 'Vault', icon: 'shield_lock', minRole: 'admin' },
        { to: '/api-tokens', label: 'API tokens', icon: 'key', minRole: 'admin' },
        { to: '/audit-log', label: 'Audit Log', icon: 'policy', minRole: 'admin' },
        { to: '/backups', label: 'Backups', icon: 'backup', minRole: 'admin' },
      ],
    },
  ],
  roleRank: ROLE_RANK,
  brand: { iconUrl: uiConfig.brand.logoLight, name: uiConfig.brand.name, title: 'Template', subtitle: 'Built from the Better modules' },
  homePath: '/',
  settingsPath: '/settings',
  loginPath: '/login',
  externalLinks: [],
  whatsNew: { changelog: '', version: '0.1.0', docsUrl: 'https://example.invalid' },
})

const ENTITIES: AuditEntities = {
  labels: {
    user: 'User', 'user-security': 'User Security', api_token: 'API Token', oidc_settings: 'SSO Settings', sign_in: 'Sign-in',
    vault: 'Vault', vault_secret: 'Vault Secret', notification_channel: 'Notification Channel', smtp_settings: 'SMTP Settings',
    notification_delivery: 'Notification Delivery', backup: 'Backup', 'backup-config': 'Backup Schedule',
  },
  icons: {
    user: 'person', 'user-security': 'manage_accounts', api_token: 'key', oidc_settings: 'admin_panel_settings', sign_in: 'login',
    vault: 'shield_lock', vault_secret: 'key', notification_channel: 'notifications', smtp_settings: 'email',
    notification_delivery: 'send', backup: 'backup', 'backup-config': 'schedule',
  },
  groups: [
    { label: 'Access & security', types: ['sign_in', 'user', 'user-security', 'api_token', 'oidc_settings', 'vault', 'vault_secret'] },
    { label: 'Notifications', types: ['notification_channel', 'smtp_settings', 'notification_delivery'] },
    { label: 'System', types: ['backup', 'backup-config'] },
  ],
}

const ROLES = [
  { value: 'admin', label: 'Admin', desc: 'Full access' },
  { value: 'member', label: 'Member', desc: 'Everything except administration' },
]

function SignIn() {
  return (
  <LoginPage headline="Welcome back." tagline="An application built from the Better modules." features={[{ icon: 'bolt', label: 'Everything the modules share' }]} />
  )
}

function Home() {
  return (
    <div className="p-8">
      <h1 className="font-headline text-2xl font-bold" style={{ color: 'var(--m3-on-surface)' }}>Home</h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--m3-secondary)' }}>
        This page is the application&apos;s own. Everything else comes from the shared modules.
      </p>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/sso-confirm" element={<SsoConfirmPage />} />
          <Route path="/login" element={<SetupGate><SignIn /></SetupGate>} />
          <Route path="/change-password" element={<SetupGate><RequireAuth><ChangePasswordPage /></RequireAuth></SetupGate>} />
          <Route path="/*" element={<SetupGate><RequireAuth><RequirePasswordChanged><Shell /></RequirePasswordChanged></RequireAuth></SetupGate>}>
            <Route index element={<Home />} />
            <Route path="users" element={<RequireRole minRole="admin"><UsersPage roles={ROLES} roleRank={ROLE_RANK} defaultRole="member" /></RequireRole>} />
            <Route path="vault" element={<RequireRole minRole="admin"><VaultPage /></RequireRole>} />
            <Route path="api-tokens" element={<RequireRole minRole="admin"><ApiTokensPage resources={TOKEN_RESOURCES} presets={[]} /></RequireRole>} />
            <Route path="audit-log" element={<RequireRole minRole="admin"><AuditLogPage entities={ENTITIES} /></RequireRole>} />
            <Route path="backups" element={<RequireRole minRole="admin"><BackupsPage /></RequireRole>} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
