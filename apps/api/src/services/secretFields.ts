/**
 * Which parts of a monitor or notification channel configuration are secrets.
 *
 * Secrets never leave the API as stored: reads get a mask, and a write that sends the mask back means "keep the
 * stored value". The same table drives the config export, so a new secret field is declared in exactly one place.
 * Values read from a vault are references, not secrets, and are not listed here.
 *
 * The table is grouped by type for readability, but masking and restoring look at every secret field of the kind
 * whatever the object's type. A config can hold leftovers of another type (the type changed, or an API client sent
 * extra keys), and those must not read back in the clear.
 */

export const SECRET_MASK = '••••••••'

/** Three bullets in a row are never part of a real secret; they are a mask, or a mask somebody edited by hand. */
const LOOKS_MASKED = /•{3}/

export type ConfigKind = 'monitor' | 'channel'

type SecretField =
  /** A string at `path`; `tail` also shows its last 4 characters (long tokens only) so it can be recognised. */
  | { path: readonly string[]; tail?: true }
  /** Every entry of the object at `mapAt` whose key names a credential (Authorization, X-Api-Key, ...). */
  | { mapAt: readonly string[] }

/** Credential-looking header names. Wide on purpose: masking `X-Idempotency-Key` costs nothing, leaking `X-Auth` does. */
const SENSITIVE_HEADER = /auth|token|secret|key|pass|pwd|credential|cookie|session|signature/i

const DATABASE_SECRETS: readonly SecretField[] = [{ path: ['password'] }]
const WEBHOOK_URL_SECRET: readonly SecretField[] = [{ path: ['webhookUrl'] }]

const MONITOR_SECRETS: Readonly<Record<string, readonly SecretField[]>> = {
  https: [
    { path: ['auth', 'basic', 'password'] },
    { path: ['auth', 'oauth2', 'clientSecret'] },
    { path: ['auth', 'cas', 'password'] },
    { mapAt: ['headers'] },
  ],
  sqlserver: DATABASE_SECRETS,
  postgresql: DATABASE_SECRETS,
  mysql: DATABASE_SECRETS,
  mongodb: DATABASE_SECRETS,
}

const CHANNEL_SECRETS: Readonly<Record<string, readonly SecretField[]>> = {
  webhook: [{ mapAt: ['headers'] }],
  slack: WEBHOOK_URL_SECRET,
  discord: WEBHOOK_URL_SECRET,
  teams: WEBHOOK_URL_SECRET,
  telegram: [{ path: ['botToken'], tail: true }],
}

/**
 * Where a secret ends up. Keeping a stored secret while this changes would let whoever edits the object send it to a
 * host of their choosing, so the secret must be entered again. A channel whose secret is its own URL, and Telegram
 * (fixed host), have nothing to list.
 */
const MONITOR_DESTINATIONS: readonly (readonly string[])[] = [
  ['url'], ['auth', 'oauth2', 'tokenUrl'], ['auth', 'cas', 'casServerUrl'], ['host'], ['port'],
]
const CHANNEL_DESTINATIONS: readonly (readonly string[])[] = [['url']]

const unique = (fields: readonly SecretField[]): SecretField[] => {
  const seen = new Set<string>()
  return fields.filter((field) => {
    const id = 'mapAt' in field ? `map:${field.mapAt.join('.')}` : `path:${field.path.join('.')}`
    return seen.has(id) ? false : (seen.add(id), true)
  })
}

const FIELDS: Readonly<Record<ConfigKind, readonly SecretField[]>> = {
  monitor: unique(Object.values(MONITOR_SECRETS).flat()),
  channel: unique(Object.values(CHANNEL_SECRETS).flat()),
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

function valueAt(root: unknown, path: readonly string[]): unknown {
  let current = root
  for (const segment of path) {
    if (!isObject(current)) return undefined
    current = current[segment]
  }
  return current
}

/** One concrete secret value: the object holding it and its key, plus the dotted name used in messages. */
interface Slot { holder: Json; key: string; label: string; tail: boolean }

function slotsIn(config: unknown, kind: ConfigKind): Slot[] {
  const slots: Slot[] = []
  for (const field of FIELDS[kind]) {
    if ('mapAt' in field) {
      const holder = valueAt(config, field.mapAt)
      if (!isObject(holder)) continue
      for (const key of Object.keys(holder)) {
        if (SENSITIVE_HEADER.test(key)) slots.push({ holder, key, label: `${field.mapAt.join('.')}.${key}`, tail: false })
      }
    } else {
      const holder = valueAt(config, field.path.slice(0, -1))
      const key = field.path[field.path.length - 1]!
      if (isObject(holder) && key in holder) slots.push({ holder, key, label: field.path.join('.'), tail: field.tail === true })
    }
  }
  return slots
}

/** `••••••••`, plus the last 4 characters of a long token so it can be told apart from another one. */
function mask(value: string, tail: boolean): string {
  return `${SECRET_MASK}${tail && value.length >= 16 ? value.slice(-4) : ''}`
}

/** A copy of `config` with every secret replaced by its mask, whatever its type (a number is as secret as a string). */
export function maskSecrets<T>(kind: ConfigKind, config: T): T {
  const copy = structuredClone(config)
  for (const { holder, key, tail } of slotsIn(copy, kind)) {
    const value = holder[key]
    if (value !== null && value !== undefined && value !== '') holder[key] = mask(String(value), tail)
  }
  return copy
}

export type RestoreResult = { config: unknown } | { error: string }

/**
 * Resolves the secrets of an incoming config against the stored one: a mask that matches the stored secret becomes
 * that secret again. Refused instead of saved:
 *  - a mask, or something that looks like an edited mask, that matches nothing stored;
 *  - a secret that is not text;
 *  - a kept secret while the place it is sent to changed (URL, host, port), so it cannot be redirected.
 * Pass `stored` as undefined for a new object (or one whose type changed), where any mask is a mistake.
 */
export function restoreSecrets(kind: ConfigKind, incoming: unknown, stored: unknown): RestoreResult {
  const copy = structuredClone(incoming)
  const storedSlots = new Map(slotsIn(stored, kind).map((slot) => [slot.label, slot]))
  let kept = false
  for (const { holder, key, label, tail } of slotsIn(copy, kind)) {
    const value = holder[key]
    if (value === null || value === undefined) continue
    if (typeof value !== 'string') return { error: `${label} must be text` }
    if (!LOOKS_MASKED.test(value)) continue
    const previous = storedSlots.get(label)
    const original = previous?.holder[previous.key]
    if (typeof original === 'string' && original && value === mask(original, tail)) {
      holder[key] = original
      kept = true
    } else {
      return { error: `${label} is a masked placeholder that does not match the stored value; enter the full value to replace it` }
    }
  }
  if (kept) {
    for (const path of kind === 'monitor' ? MONITOR_DESTINATIONS : CHANNEL_DESTINATIONS) {
      if (JSON.stringify(valueAt(copy, path) ?? null) !== JSON.stringify(valueAt(stored, path) ?? null)) {
        return { error: `${path.join('.')} changed, so the stored secrets cannot be kept; enter them again` }
      }
    }
  }
  return { config: copy }
}
