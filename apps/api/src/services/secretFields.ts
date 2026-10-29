import { createSecretFields, uniqueSecretFields, type LooseningSwitch, type SecretField } from '@better-forge/vault'
import { CHANNEL_DESTINATIONS, CHANNEL_SECRETS } from '@better-forge/notify'

export { SECRET_MASK } from '@better-forge/vault'
export type { RestoreResult } from '@better-forge/vault'

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

export type ConfigKind = 'monitor' | 'channel'

const DATABASE_SECRETS: readonly SecretField[] = [{ path: ['password'] }]

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
  oracle: DATABASE_SECRETS,
  redis: DATABASE_SECRETS,
  mail: DATABASE_SECRETS,
}

const MONITOR_DESTINATIONS: readonly (readonly string[])[] = [
  ['url'], ['auth', 'oauth2', 'tokenUrl'], ['auth', 'cas', 'casServerUrl'], ['host'], ['port'],
  // Another authority to trust, or a mail connection that stops being encrypted, sends the kept password where it is not protected.
  ['tlsCa'], ['security'],
]

/** Turning certificate checks off makes the same destination less safe; turning them back on does not. */
const MONITOR_LOOSENING: readonly LooseningSwitch[] = [['ignoreTls'], { path: ['verifyTls'], value: false }, { path: ['tls'], value: false }]

const secretFields = createSecretFields<ConfigKind>({
  monitor: { fields: uniqueSecretFields(Object.values(MONITOR_SECRETS).flat()), destinations: MONITOR_DESTINATIONS, loosening: MONITOR_LOOSENING },
  channel: { fields: uniqueSecretFields(Object.values(CHANNEL_SECRETS).flat()), destinations: CHANNEL_DESTINATIONS },
})

export const { maskSecrets, restoreSecrets, changedDestination, configCodec } = secretFields

/** Where the secrets of a monitor type sit in its config, as dotted paths (`headers.*` = every credential header). */
export const monitorSecretPaths = (type: string): string[] =>
  (MONITOR_SECRETS[type] ?? []).map((field) => 'path' in field ? field.path.join('.') : `${field.mapAt.join('.')}.*`)
