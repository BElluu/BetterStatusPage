import { normalizeScopes as normalizeKnownScopes, VAULT_USE_SCOPE, type TokenPreset, type TokenResource } from '@better-kit/contracts'

/** Every part of the admin API a token can be given access to, in the order the permissions are listed. */
export const TOKEN_RESOURCES: readonly TokenResource[] = [
  { key: 'monitors', label: 'Monitors', description: 'Monitors, their tests, checks and dependencies', levels: ['read', 'write'] },
  { key: 'channels', label: 'Notification channels', description: 'Channels, SMTP settings and delivery history', levels: ['read', 'write'] },
  { key: 'actions', label: 'Actions', description: 'HTTP actions that run when a monitor goes down or recovers, and their run history', levels: ['read', 'write'] },
  { key: 'incidents', label: 'Incidents', description: 'Open, update and close incidents', levels: ['read', 'write'] },
  { key: 'maintenance', label: 'Maintenance windows', description: 'Schedule and change maintenance windows', levels: ['read', 'write'] },
  { key: 'subscribers', label: 'Subscribers', description: 'Subscribers and subscription settings', levels: ['read', 'write'] },
  { key: 'reports', label: 'Reports', description: 'Uptime reports', levels: ['read'] },
  { key: 'appearance', label: 'Status page appearance', description: 'The layout, branding and languages', levels: ['read', 'write'] },
  { key: 'audit', label: 'Audit log', description: 'Read the audit log', levels: ['read'] },
  { key: 'system', label: 'System health', description: 'Read the health of the instance', levels: ['read'] },
  { key: 'metrics', label: 'Metrics', description: 'Scrape monitor status and response times as Prometheus metrics', levels: ['read'] },
]

export const API_TOKEN_SCOPES: readonly string[] = [
  ...TOKEN_RESOURCES.flatMap((resource) => resource.levels.map((level) => `${resource.key}:${level}`)),
  VAULT_USE_SCOPE,
]

export const TOKEN_PRESETS: readonly TokenPreset[] = [
  { label: 'Report incidents', description: 'Open and update incidents from a pipeline', scopes: ['incidents:write', 'monitors:read'] },
  { label: 'Deploy monitoring', description: 'Create and update monitors and channels from files', scopes: ['monitors:write', 'channels:write'] },
  { label: 'Read only', description: 'Read everything, change nothing', scopes: API_TOKEN_SCOPES.filter((scope) => scope.endsWith(':read')) },
]

/** A clean list of known permissions (reading added wherever writing is granted), or null if one is unknown or none is given. */
export function normalizeScopes(input: unknown): string[] | null {
  return normalizeKnownScopes(input, API_TOKEN_SCOPES)
}
