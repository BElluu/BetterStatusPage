/**
 * What an API token may do. A token carries a list of permissions instead of a role: each one names a part of the
 * admin API and whether it may be read (`:read`) or changed (`:write`, which includes reading). `vault:use` is a
 * separate permission to use secrets from a vault in a monitor, channel or SMTP configuration.
 */

export interface TokenResource {
  key: string
  label: string
  description: string
  /** `read` only for parts that cannot be changed through the API. */
  levels: readonly ('read' | 'write')[]
}

export const TOKEN_RESOURCES: readonly TokenResource[] = [
  { key: 'monitors', label: 'Monitors', description: 'Monitors, their tests, checks and dependencies', levels: ['read', 'write'] },
  { key: 'channels', label: 'Notification channels', description: 'Channels, SMTP settings and delivery history', levels: ['read', 'write'] },
  { key: 'incidents', label: 'Incidents', description: 'Open, update and close incidents', levels: ['read', 'write'] },
  { key: 'maintenance', label: 'Maintenance windows', description: 'Schedule and change maintenance windows', levels: ['read', 'write'] },
  { key: 'subscribers', label: 'Subscribers', description: 'Subscribers and subscription settings', levels: ['read', 'write'] },
  { key: 'reports', label: 'Reports', description: 'Uptime reports', levels: ['read'] },
  { key: 'appearance', label: 'Status page appearance', description: 'The layout, branding and languages', levels: ['read', 'write'] },
  { key: 'audit', label: 'Audit log', description: 'Read the audit log', levels: ['read'] },
  { key: 'system', label: 'System health', description: 'Read the health of the instance', levels: ['read'] },
]

/** Lets a token set, change or test a monitor, channel or SMTP configuration that reads a secret from a vault. */
export const VAULT_USE_SCOPE = 'vault:use'

export const API_TOKEN_SCOPES: readonly string[] = [
  ...TOKEN_RESOURCES.flatMap((resource) => resource.levels.map((level) => `${resource.key}:${level}`)),
  VAULT_USE_SCOPE,
]

export interface TokenPreset { label: string; description: string; scopes: readonly string[] }

export const TOKEN_PRESETS: readonly TokenPreset[] = [
  { label: 'Report incidents', description: 'Open and update incidents from a pipeline', scopes: ['incidents:write', 'monitors:read'] },
  { label: 'Deploy monitoring', description: 'Create and update monitors, channels and the layout from files', scopes: ['monitors:write', 'channels:write', 'appearance:write'] },
  { label: 'Read only', description: 'Read everything, change nothing', scopes: API_TOKEN_SCOPES.filter((scope) => scope.endsWith(':read')) },
]

/**
 * The permissions a token needs for a request: `<resource>:read` for GET and HEAD, `<resource>:write` for anything
 * else. The vault catalogue is the one part with a single permission.
 */
export function requiredScope(resource: string, method: string): string {
  if (resource === 'vault') return VAULT_USE_SCOPE
  return `${resource}:${method === 'GET' || method === 'HEAD' ? 'read' : 'write'}`
}

/** Whether a token with `granted` may do what needs `required`. Writing a part includes reading it. */
export function tokenAllows(granted: readonly string[], required: string): boolean {
  if (granted.includes(required)) return true
  return required.endsWith(':read') && granted.includes(`${required.slice(0, -':read'.length)}:write`)
}

/** A clean list of known permissions (reading added wherever writing is granted), or null if one is unknown or none is given. */
export function normalizeScopes(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length === 0 || !input.every((scope) => typeof scope === 'string' && API_TOKEN_SCOPES.includes(scope))) return null
  const scopes = new Set<string>(input as string[])
  for (const scope of input as string[]) if (scope.endsWith(':write') && API_TOKEN_SCOPES.includes(`${scope.slice(0, -':write'.length)}:read`)) scopes.add(`${scope.slice(0, -':write'.length)}:read`)
  return API_TOKEN_SCOPES.filter((scope) => scopes.has(scope))
}
