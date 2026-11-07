import { eq } from 'drizzle-orm'
import { SSO_GROUP_ROLES, type SsoGroupRole, type SsoProvisioningSettings } from '@bsp/shared'
import { db } from '../db/client.js'
import { ssoProvisioning } from '../db/schema.js'
import { roles } from '../kit/roles.js'
import { normalizeViewerDomains } from './statusPageAccess.js'

export class SsoProvisioningError extends Error {}

const MAX_GROUP_ROLES = 50
const MAX_GROUP_LENGTH = 256
/** More groups than this in a token are not looked at: a mapped group beyond them is never found, so nobody gets a role by accident. */
const MAX_TOKEN_GROUPS = 500
const CLAIM_PATTERN = /^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9_:.\-/]{1,100}$/
const DEFAULTS: SsoProvisioningSettings = { enabled: false, allowedDomains: [], groupsClaim: 'groups', groupRoles: [] }

function isGroupRole(role: unknown): role is SsoGroupRole['role'] {
  return typeof role === 'string' && (SSO_GROUP_ROLES as readonly string[]).includes(role)
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return []
  }
}

function parseGroupRoles(raw: string): SsoGroupRole[] {
  const parsed = parseJson(raw)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry): entry is SsoGroupRole => typeof entry?.group === 'string' && typeof entry?.role === 'string')
}

export async function getSsoProvisioning(): Promise<SsoProvisioningSettings> {
  const row = (await db.select().from(ssoProvisioning).where(eq(ssoProvisioning.id, 1)))[0]
  if (!row) return { ...DEFAULTS }
  const domains = parseJson(row.allowedDomains)
  return {
    enabled: !!row.enabled,
    allowedDomains: Array.isArray(domains) ? domains.filter((value): value is string => typeof value === 'string') : [],
    groupsClaim: row.groupsClaim,
    groupRoles: parseGroupRoles(row.groupRoles),
  }
}

/** Validates the input of the settings form. Throws a SsoProvisioningError the form can show. */
export function normalizeSsoProvisioning(input: Partial<Record<keyof SsoProvisioningSettings, unknown>>): SsoProvisioningSettings {
  let allowedDomains: string[]
  try {
    allowedDomains = normalizeViewerDomains(input.allowedDomains ?? [])
  } catch (error) {
    throw new SsoProvisioningError(error instanceof Error ? error.message : 'Invalid email domains')
  }
  const groupsClaim = typeof input.groupsClaim === 'string' ? input.groupsClaim.trim() : DEFAULTS.groupsClaim
  if (!CLAIM_PATTERN.test(groupsClaim)) throw new SsoProvisioningError('The groups claim must be a claim name such as "groups"')
  if (input.groupRoles !== undefined && !Array.isArray(input.groupRoles)) throw new SsoProvisioningError('The group mapping must be a list')
  const entries = (input.groupRoles ?? []) as unknown[]
  if (entries.length > MAX_GROUP_ROLES) throw new SsoProvisioningError(`At most ${MAX_GROUP_ROLES} groups can be mapped`)
  const byGroup = new Map<string, SsoGroupRole['role']>()
  for (const entry of entries) {
    const { group: rawGroup, role } = (entry ?? {}) as { group?: unknown; role?: unknown }
    if (typeof rawGroup !== 'string' || !rawGroup.trim()) throw new SsoProvisioningError('Every mapping needs a group name')
    // Spaces around a name would never match what the provider sends, and "A" and "A " are one group.
    const group = rawGroup.trim()
    if (group.length > MAX_GROUP_LENGTH) throw new SsoProvisioningError(`A group name can be at most ${MAX_GROUP_LENGTH} characters`)
    if (!isGroupRole(role) || !roles.isValid(role)) {
      throw new SsoProvisioningError(`The role of "${group}" must be one of ${SSO_GROUP_ROLES.join(', ')}`)
    }
    if (byGroup.has(group)) throw new SsoProvisioningError(`The group "${group}" is mapped twice`)
    byGroup.set(group, role)
  }
  const next: SsoProvisioningSettings = {
    enabled: input.enabled === true,
    allowedDomains,
    groupsClaim,
    groupRoles: [...byGroup].map(([group, role]) => ({ group, role })),
  }
  // Without a domain list anybody with an account at a multi-tenant provider (Google, Microsoft personal accounts) could sign up.
  if (next.enabled && next.allowedDomains.length === 0) throw new SsoProvisioningError('Add at least one email domain to create accounts on SSO sign-in')
  if (next.enabled && next.groupRoles.length === 0) throw new SsoProvisioningError('Map at least one group to a role to create accounts on SSO sign-in')
  return next
}

export async function saveSsoProvisioning(next: SsoProvisioningSettings): Promise<SsoProvisioningSettings> {
  const row = {
    enabled: next.enabled ? 1 : 0,
    allowedDomains: JSON.stringify(next.allowedDomains),
    groupsClaim: next.groupsClaim,
    groupRoles: JSON.stringify(next.groupRoles),
    updatedAt: Date.now(),
  }
  await db.insert(ssoProvisioning).values({ id: 1, ...row }).onConflictDoUpdate({ target: ssoProvisioning.id, set: row })
  return next
}

/**
 * The role of the account a first SSO sign-in from the admin panel creates, with the rule that gave it (it goes to the audit
 * log), or null to refuse. All of these must hold:
 * the feature is on, the email's domain is listed, the groups claim is a list of names, and one of them is mapped.
 * Whether the email may be trusted at all was decided before: the SSO settings refuse an email the provider reports as
 * unverified, and accept a provider that sends no such claim (Microsoft Entra ID) only when told to. Nothing matching never
 * falls back to a default role.
 */
export function roleForSsoSignIn(settings: SsoProvisioningSettings, email: string, claims: Record<string, unknown>): { role: string; reason: string } | null {
  if (!settings.enabled) return null
  const at = email.lastIndexOf('@')
  if (at < 1 || !settings.allowedDomains.includes(email.slice(at + 1).toLowerCase())) return null
  // Only a claim the token itself carries, never an inherited property.
  const groups = Object.hasOwn(claims, settings.groupsClaim) ? claims[settings.groupsClaim] : undefined
  if (!Array.isArray(groups)) return null
  const inToken = new Set(groups.slice(0, MAX_TOKEN_GROUPS).filter((group): group is string => typeof group === 'string'))
  let best = -1
  const matched: string[] = []
  for (const { group, role } of settings.groupRoles) {
    if (!inToken.has(group)) continue
    matched.push(`${group} (${role})`)
    best = Math.max(best, (SSO_GROUP_ROLES as readonly string[]).indexOf(role))
  }
  return best < 0 ? null : { role: SSO_GROUP_ROLES[best]!, reason: `Group mapping, domain ${email.slice(at + 1).toLowerCase()}: ${matched.join(', ')}` }
}
