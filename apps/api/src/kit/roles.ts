import { createRoleRegistry } from '@better-forge/auth'

/** The roles of this application besides `admin`. `viewer` may only view a private status page; it has no access to the admin console. */
export const APP_ROLES = ['operator', 'branding', 'viewer'] as const

export const roles = createRoleRegistry()
roles.register(APP_ROLES, { fallback: 'branding', defaultForNewUsers: 'branding' })
