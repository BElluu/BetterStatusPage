import { AuditLogPage, type AuditEntities } from '@better-kit/ui'
import type { AuditEntityType } from '@bsp/shared'

const ENTITY_LABELS: Record<AuditEntityType, string> = {
  monitor:              'Monitor',
  incident:             'Incident',
  incident_template:    'Incident Template',
  maintenance:          'Maintenance',
  notification_channel: 'Notification Channel',
  action:               'Action',
  action_run:           'Action Run',
  smtp_settings:        'SMTP Settings',
  subscription_settings: 'Subscription Settings',
  subscriber:           'Subscriber',
  vault:                'Vault',
  vault_secret:         'Vault Secret',
  user:                 'User',
  api_token:            'API Token',
  oidc_settings:        'SSO Settings',
  status_page_access:   'Status Page Access',
  mcp_settings:         'MCP',
  static_mirror:        'Static Fallback',
  'user-security':      'User Security',
  branding:             'Branding',
  layout:               'Status Page Layout',
  config:               'Import',
  locale:               'Language',
  backup:               'Backup',
  'backup-config':      'Backup Schedule',
  notification_delivery: 'Notification Delivery',
  subscriber_delivery:  'Subscriber Delivery',
  sign_in:              'Sign-in',
}

/** Entity filter sections, most used first; types inside a group run from most to least important. */
const ENTITY_GROUPS = [
  { label: 'Monitoring', types: ['monitor', 'incident', 'incident_template', 'maintenance'] },
  { label: 'Notifications', types: ['notification_channel', 'action', 'action_run', 'notification_delivery', 'smtp_settings', 'subscriber', 'subscriber_delivery', 'subscription_settings'] },
  { label: 'Access & security', types: ['sign_in', 'user', 'user-security', 'api_token', 'oidc_settings', 'status_page_access', 'mcp_settings', 'vault', 'vault_secret'] },
  { label: 'Appearance', types: ['branding', 'layout', 'locale'] },
  { label: 'System', types: ['backup', 'backup-config', 'config', 'static_mirror'] },
] as const satisfies readonly { label: string; types: readonly AuditEntityType[] }[]

// Compile error here means an AuditEntityType is missing from ENTITY_GROUPS.
export const ENTITY_TYPES_ALL_GROUPED: Exclude<AuditEntityType, (typeof ENTITY_GROUPS)[number]['types'][number]> extends never ? true : never = true

const ENTITY_ICONS: Record<AuditEntityType, string> = {
  monitor:              'radio_button_checked',
  incident:             'warning',
  incident_template:    'article',
  maintenance:          'construction',
  notification_channel: 'notifications',
  action:               'bolt',
  action_run:           'bolt',
  smtp_settings:        'email',
  subscription_settings: 'campaign',
  subscriber:           'person_add',
  vault:                'shield_lock',
  vault_secret:         'key',
  user:                 'person',
  api_token:            'key',
  oidc_settings:        'admin_panel_settings',
  status_page_access:   'lock',
  mcp_settings:         'smart_toy',
  static_mirror:        'cloud_upload',
  'user-security':      'manage_accounts',
  branding:             'palette',
  layout:               'dashboard',
  config:               'upload_file',
  locale:               'translate',
  backup:               'backup',
  'backup-config':      'schedule',
  notification_delivery: 'send',
  subscriber_delivery:  'send',
  sign_in:              'login',
}

const ENTITIES: AuditEntities = { labels: ENTITY_LABELS, icons: ENTITY_ICONS, groups: ENTITY_GROUPS }

/** The audit log with the things this product records. */
export default function AuditLog() {
  return <AuditLogPage entities={ENTITIES} />
}
