import { createAdminShell, type AdminShellConfig, type NavSection } from '@better-kit/ui'
import changelogSource from '../../../../docs/changelog.md?raw'
import packageMetadata from '../../package.json'
import { DOCS_URL, statusPageUrl } from '../navigation'

// role hierarchy: admin > operator > branding
export const ROLE_RANK: Record<string, number> = { admin: 3, operator: 2, branding: 1 }

export const ALL_SECTIONS: NavSection[] = [
  {
    label: 'Monitoring',
    items: [
      { to: '/admin/',            label: 'Dashboard',    icon: 'dashboard',            minRole: 'operator' },
      { to: '/admin/monitors',    label: 'Monitors',     icon: 'radio_button_checked', minRole: 'operator' },
      { to: '/admin/incidents',   label: 'Incidents',    icon: 'warning',              minRole: 'operator' },
      { to: '/admin/maintenance', label: 'Maintenance',  icon: 'construction',         minRole: 'operator' },
      { to: '/admin/reports',     label: 'Reports',      icon: 'assessment',           minRole: 'operator' },
    ],
  },
  {
    label: 'Alerts',
    items: [
      { to: '/admin/notifications',    label: 'Notifications',    icon: 'notifications', minRole: 'operator' },
      { to: '/admin/actions',          label: 'Actions',          icon: 'bolt',          minRole: 'admin' },
      { to: '/admin/delivery-history', label: 'Delivery history', icon: 'history',       minRole: 'operator' },
    ],
  },
  {
    label: 'Status page',
    items: [
      { to: '/admin/builder',      label: 'Page Builder', icon: 'dashboard_customize', minRole: 'branding' },
      { to: '/admin/branding',     label: 'Branding',     icon: 'palette',             minRole: 'branding' },
      { to: '/admin/localization', label: 'Localization', icon: 'translate',           minRole: 'branding' },
      { to: '/admin/subscribers',  label: 'Subscribers',  icon: 'campaign',            minRole: 'operator' },
      { to: '/admin/static-fallback', label: 'Static fallback', icon: 'cloud_upload',   minRole: 'admin' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/admin/users',     label: 'Users',     icon: 'group',        minRole: 'admin' },
      { to: '/admin/vault',     label: 'Vault',     icon: 'shield_lock',  minRole: 'admin' },
      { to: '/admin/api-tokens', label: 'API tokens', icon: 'key',        minRole: 'admin' },
      { to: '/admin/audit-log', label: 'Audit Log', icon: 'policy',       minRole: 'admin' },
      { to: '/admin/backups',   label: 'Backups',   icon: 'backup',       minRole: 'admin' },
      { to: '/admin/system-health', label: 'System Health', icon: 'monitor_heart', minRole: 'admin' },
    ],
  },
]

export const SHELL_CONFIG: AdminShellConfig = {
  sections: ALL_SECTIONS,
  roleRank: ROLE_RANK,
  brand: { iconUrl: '/admin/icon.png', name: 'BetterStatusPage', title: 'Admin Console', subtitle: 'Reliability Engineering' },
  homePath: '/admin/',
  settingsPath: '/admin/settings',
  loginPath: '/admin/login',
  externalLinks: [
    { label: 'Status page', icon: 'open_in_new', href: statusPageUrl },
    { label: 'Documentation', icon: 'menu_book', href: () => DOCS_URL },
  ],
  whatsNew: { changelog: changelogSource, version: packageMetadata.version, docsUrl: DOCS_URL },
}

export default createAdminShell(SHELL_CONFIG)
