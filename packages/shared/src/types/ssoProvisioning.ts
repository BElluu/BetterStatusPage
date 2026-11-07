/** The roles a group may give, lowest access first. A person in several mapped groups gets the highest. */
export const SSO_GROUP_ROLES = ['viewer', 'branding', 'operator', 'admin'] as const

/** A role BetterStatusPage gives to the members of a group at the identity provider. */
export interface SsoGroupRole {
  /** The group exactly as the identity provider names it (case-sensitive). */
  group: string
  role: (typeof SSO_GROUP_ROLES)[number]
}

/**
 * Who a first SSO sign-in from the admin panel creates an account for. A sign-in from a private status page is not
 * governed by this: it only ever creates a viewer, see the status page access settings.
 */
export interface SsoProvisioningSettings {
  enabled: boolean
  /** Email domains (lowercase, without "@") that may sign up; at least one while enabled. */
  allowedDomains: string[]
  /** The ID token claim that lists the person's groups, for example `groups`. */
  groupsClaim: string
  /** Group to role. The person gets the highest role of the groups they belong to; none matching refuses the sign-in. */
  groupRoles: SsoGroupRole[]
}

/**
 * Whether a change gives more than the saved settings did: a new sign-up path, another claim, a higher role for a group
 * or a new domain. The API asks for confirmation then, and so does the form. Switching things off never does.
 */
export function widensSsoProvisioning(before: SsoProvisioningSettings, after: SsoProvisioningSettings): boolean {
  if (!after.enabled) return false
  if (!before.enabled || before.groupsClaim !== after.groupsClaim) return true
  const rank = (role: string | undefined) => (role === undefined ? -1 : (SSO_GROUP_ROLES as readonly string[]).indexOf(role))
  const was = new Map(before.groupRoles.map((entry) => [entry.group, entry.role]))
  return after.groupRoles.some((entry) => rank(entry.role) > rank(was.get(entry.group)))
    || after.allowedDomains.some((domain) => !before.allowedDomains.includes(domain))
}

/** The settings as the admin console sees them. */
export interface AdminSsoProvisioning extends SsoProvisioningSettings {
  ssoConfigured: boolean
}
