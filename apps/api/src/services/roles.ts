export const VALID_ROLES = ['admin', 'operator', 'branding'] as const

export type UserRole = typeof VALID_ROLES[number]

/** Normalize stored role values, including the legacy JSON-array format. */
export function normalizeRole(raw: string): UserRole {
  try {
    const parsed: unknown = JSON.parse(raw)
    const role = Array.isArray(parsed) ? parsed[0] : raw
    return typeof role === 'string' && (VALID_ROLES as readonly string[]).includes(role)
      ? role as UserRole
      : 'branding'
  } catch {
    return (VALID_ROLES as readonly string[]).includes(raw) ? raw as UserRole : 'branding'
  }
}
