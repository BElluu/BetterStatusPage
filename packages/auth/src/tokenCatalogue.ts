import type { TokenPreset, TokenResource } from '@better-kit/contracts'
import { VAULT_USE_SCOPE, normalizeScopes } from '@better-kit/contracts'

export interface TokenCatalogue {
  /** Every permission a token can hold, in the order they are listed: `<part>:read`, `<part>:write`, then the extra ones. */
  readonly scopes: readonly string[]
  readonly resources: readonly TokenResource[]
  readonly presets: readonly TokenPreset[]
  /** A clean list of known permissions (reading added wherever writing is granted), or null if one is unknown or none is given. */
  normalize(input: unknown): string[] | null
  /** The permissions stored with a token. Anything that is not a known permission is dropped. */
  parse(stored: string): string[]
}

/**
 * The permissions an API token can be given. A part is a group of routes (`belongsTo(scope, part)` ties routes to
 * it); `extraScopes` are single permissions that belong to no part, such as the one to use vault secrets.
 */
export function createTokenCatalogue(options: {
  resources: readonly TokenResource[]
  extraScopes?: readonly string[]
  presets?: (scopes: readonly string[]) => readonly TokenPreset[]
}): TokenCatalogue {
  const scopes = [
    ...options.resources.flatMap((resource) => resource.levels.map((level) => `${resource.key}:${level}`)),
    ...(options.extraScopes ?? [VAULT_USE_SCOPE]),
  ]
  return {
    scopes,
    resources: options.resources,
    presets: options.presets?.(scopes) ?? [],
    normalize: (input) => normalizeScopes(input, scopes),
    parse(stored) {
      try {
        const parsed: unknown = JSON.parse(stored)
        return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === 'string' && scopes.includes(scope)) : []
      } catch {
        return []
      }
    },
  }
}
