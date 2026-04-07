import { db } from '../db/client.js'
import { vaultSecrets } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'
import { decrypt } from '../crypto/vault.js'
import type { VaultRef } from '@bsp/shared'

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

  if (!secret) {
    throw new Error(`Vault secret ${ref.secretId} not found in vault ${ref.vaultId}`)
  }

  const decrypted = JSON.parse(decrypt(secret.encryptedValue)) as Record<string, unknown>

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
