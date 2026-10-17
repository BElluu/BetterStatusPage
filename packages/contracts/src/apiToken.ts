/**
 * What an API token may do. A token carries a list of permissions instead of a role: each one names a part of the
 * admin API and whether it may be read (`:read`) or changed (`:write`, which includes reading). `vault:use` is a
 * separate permission to use secrets from a vault in a configuration.
 */

export interface TokenResource {
  key: string
  label: string
  description: string
  /** `read` only for parts that cannot be changed through the API. */
  levels: readonly ('read' | 'write')[]
}

/** Lets a token set, change or test a configuration that reads a secret from a vault. */
export const VAULT_USE_SCOPE = 'vault:use'

export interface TokenPreset { label: string; description: string; scopes: readonly string[] }

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

/**
 * A clean list of permissions out of `known` (reading added wherever writing is granted, ordered as `known` is), or
 * null if one is unknown or none is given.
 */
export function normalizeScopes(input: unknown, known: readonly string[]): string[] | null {
  if (!Array.isArray(input) || input.length === 0 || !input.every((scope) => typeof scope === 'string' && known.includes(scope))) return null
  const scopes = new Set<string>(input as string[])
  for (const scope of input as string[]) if (scope.endsWith(':write') && known.includes(`${scope.slice(0, -':write'.length)}:read`)) scopes.add(`${scope.slice(0, -':write'.length)}:read`)
  return known.filter((scope) => scopes.has(scope))
}
