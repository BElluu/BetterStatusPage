import { createSecretFields, uniqueSecretFields, type SecretField } from '@better-kit/vault'
import { CHANNEL_DESTINATIONS, CHANNEL_SECRETS } from '@better-kit/notify'

export { SECRET_MASK } from '@better-kit/vault'
export type { RestoreResult } from '@better-kit/vault'

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
}

const MONITOR_DESTINATIONS: readonly (readonly string[])[] = [
  ['url'], ['auth', 'oauth2', 'tokenUrl'], ['auth', 'cas', 'casServerUrl'], ['host'], ['port'],
]

const secretFields = createSecretFields<ConfigKind>({
  monitor: { fields: uniqueSecretFields(Object.values(MONITOR_SECRETS).flat()), destinations: MONITOR_DESTINATIONS },
  channel: { fields: uniqueSecretFields(Object.values(CHANNEL_SECRETS).flat()), destinations: CHANNEL_DESTINATIONS },
})

export const { maskSecrets, restoreSecrets, changedDestination } = secretFields
