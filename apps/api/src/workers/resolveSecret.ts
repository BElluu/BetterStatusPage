import { db } from '../db/client.js'
import { vaults, vaultSecrets } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'
import { decrypt } from '../crypto/vault.js'
import { HashicorpVaultError, readKvSecret } from '../services/hashicorpVault.js'
import type { VaultRef } from '@bsp/shared'

type VaultRow = typeof vaults.$inferSelect
type SecretRow = typeof vaultSecrets.$inferSelect

/**
 * Returns the stored payload of a secret in the shape `decrypt` yields for local vaults
 * (`{ username, password }`, `{ value }` where json holds a JSON string). HashiCorp vaults keep only a
 * reference `{ path, key? }`; the value is read live from Vault and shaped to match.
 */
export async function loadSecretPayload(secret: SecretRow, vault: VaultRow): Promise<Record<string, unknown>> {
  if (vault.type !== 'hashicorp') return JSON.parse(decrypt(secret.encryptedValue)) as Record<string, unknown>
  try {
    const ref = JSON.parse(decrypt(secret.encryptedValue)) as { path: string; key?: string }
    const kv = await readKvSecret(vault, ref.path)
    if (secret.type === 'userpass') {
      if (typeof kv['username'] !== 'string' || typeof kv['password'] !== 'string') {
        throw new HashicorpVaultError('keys "username" and "password" are required at the path')
      }
      return { username: kv['username'], password: kv['password'] }
    }
    if (secret.type === 'value') {
      const found = ref.key ? kv[ref.key] : undefined
      if (found === undefined || found === null) throw new HashicorpVaultError(`key "${ref.key ?? ''}" not found`)
      return { value: typeof found === 'string' ? found : JSON.stringify(found) }
    }
    return { value: JSON.stringify(kv) }
  } catch (e) {
    if (e instanceof HashicorpVaultError) throw new Error(`HashiCorp Vault "${vault.name}": ${e.message}`)
    throw e
  }
}

/**
 * Resolves a vault secret reference to a flat string map.
 *
 * - userpass → { username, password }
 * - value    → { value }
 * - json     → all keys as strings, or filtered/renamed via fieldMapping
 *              e.g. fieldMapping = { clientId: 'client_id' } → { clientId: <json.client_id> }
 */
export async function resolveVaultSecret(ref: VaultRef): Promise<Record<string, string>> {
  const [secret] = await db
    .select()
    .from(vaultSecrets)
    .where(and(eq(vaultSecrets.id, ref.secretId), eq(vaultSecrets.vaultId, ref.vaultId)))

  const [vault] = secret ? await db.select().from(vaults).where(eq(vaults.id, ref.vaultId)) : []
  if (!secret || !vault) {
    throw new Error(`Vault secret ${ref.secretId} not found in vault ${ref.vaultId}`)
  }

  const decrypted = await loadSecretPayload(secret, vault)

  if (secret.type === 'userpass') {
    return {
      username: String(decrypted['username'] ?? ''),
      password: String(decrypted['password'] ?? ''),
    }
  }

  if (secret.type === 'value') {
    return { value: String(decrypted['value'] ?? '') }
  }

  if (secret.type === 'json') {
    const raw = JSON.parse(String(decrypted['value'] ?? '{}')) as Record<string, unknown>
    const { fieldMapping } = ref
    if (fieldMapping && Object.keys(fieldMapping).length > 0) {
      return Object.fromEntries(
        Object.entries(fieldMapping)
          .filter(([, jsonKey]) => !!jsonKey)
          .map(([ourField, jsonKey]) => [ourField, String(raw[jsonKey] ?? '')]),
      )
    }
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v ?? '')]))
  }

  throw new Error(`Unknown vault secret type: ${secret.type}`)
}
