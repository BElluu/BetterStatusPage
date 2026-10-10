import { tokenAllows, VAULT_USE_SCOPE } from '@bsp/shared'

export const VAULT_USE_REFUSED =
  `This token does not have the "${VAULT_USE_SCOPE}" permission, which it needs to add a vault reference or to change the configuration of a monitor or channel that has one`

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

/** Whether anything under a `vault` key is set, whatever its shape: a reference that is malformed is still treated as one. */
function holdsVault(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsVault)
  if (!isObject(value)) return false
  return Object.entries(value).some(([key, inner]) => (key === 'vault' && inner !== undefined && inner !== null && inner !== false) || holdsVault(inner))
}

/** The same text for the same value, whatever the order of keys. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/**
 * A vault secret is sent wherever the configuration that references it points, and what the target answers (a query
 * result, an error message) comes back to the caller. A token that may edit monitors but may not use vault secrets
 * therefore can neither add a reference nor change anything in a configuration that has one: it can edit the rest of
 * the monitor (name, schedule) or remove the reference. `stored` is the configuration as it is saved now, or undefined
 * for a new one. Returns a message, or null if fine.
 */
export function vaultUseProblem(token: { scopes: readonly string[] } | undefined, incoming: unknown, stored: unknown): string | null {
  if (!token || tokenAllows(token.scopes, VAULT_USE_SCOPE) || !holdsVault(incoming)) return null
  return stored !== undefined && canonical(incoming) === canonical(stored) ? null : VAULT_USE_REFUSED
}
