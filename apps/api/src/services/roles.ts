import { APP_ROLES, roles } from '../kit/roles.js'

/** `viewer` may only view a private status page; it has no access to the admin console. */
export const VALID_ROLES = ['admin', ...APP_ROLES] as const

export type UserRole = typeof VALID_ROLES[number]

/** Normalize stored role values, including the legacy JSON-array format. */
export function normalizeRole(raw: string): UserRole {
  return roles.normalize(raw) as UserRole
}
