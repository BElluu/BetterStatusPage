/** The role that may do everything; it exists in every application. */
export const ADMIN_ROLE = 'admin'

export interface RoleRegistry {
  /**
   * Adds the application's roles to `admin`. `fallback` is what a stored value that is not a role normalises to,
   * and `defaultForNewUsers` is the role an account gets when none is asked for.
   */
  register(roles: readonly string[], options: { fallback: string; defaultForNewUsers: string }): void
  /** Normalizes a stored role value, including the legacy JSON-array format. */
  normalize(raw: string): string
  isValid(role: string): boolean
  /** Every role, `admin` first, in the order they were registered. */
  list(): readonly string[]
  readonly defaultForNewUsers: string
  /** Called by createAuth: after this, registering throws, so the set of roles cannot change under a running app. */
  freeze(): void
}

export function createRoleRegistry(): RoleRegistry {
  const roles: string[] = [ADMIN_ROLE]
  let fallback: string = ADMIN_ROLE
  let defaultForNewUsers: string = ADMIN_ROLE
  let frozen = false

  const isValid = (role: string) => roles.includes(role)

  return {
    register(added, options) {
      if (frozen) throw new Error('Roles cannot be registered after the auth module was created')
      for (const role of added) if (!roles.includes(role)) roles.push(role)
      if (!roles.includes(options.fallback) || !roles.includes(options.defaultForNewUsers)) {
        throw new Error('The fallback and the default role for new users must be registered roles')
      }
      fallback = options.fallback
      defaultForNewUsers = options.defaultForNewUsers
    },
    normalize(raw) {
      try {
        const parsed: unknown = JSON.parse(raw)
        const role = Array.isArray(parsed) ? parsed[0] : raw
        return typeof role === 'string' && isValid(role) ? role : fallback
      } catch {
        return isValid(raw) ? raw : fallback
      }
    },
    isValid,
    list: () => roles,
    get defaultForNewUsers() { return defaultForNewUsers },
    freeze() { frozen = true },
  }
}
