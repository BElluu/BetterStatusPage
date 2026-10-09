import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { vaults, vaultSecrets } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'
import { encrypt, decrypt } from '../crypto/vault.js'
import { auditActor, writeAudit, diffObjects, snapshot } from '../services/audit.js'
import { requestIdentity } from '../middleware/auth.js'
import { loadSecretPayload } from '../workers/resolveSecret.js'
import {
  HashicorpVaultError, encodePath, forgetHashicorpVault, openConnection, parseConnection,
  publicConnection, readKvSecret, sealConnection, testConnection, testDraftConnection, verifyCredentialsRef, forgetCredentialDependents,
} from '../services/hashicorpVault.js'

const VALID_SECRET_TYPES = ['userpass', 'value', 'json'] as const
type SecretType = typeof VALID_SECRET_TYPES[number]

interface SecretPayload {
  userpass?: { username: string; password: string }
  value?: string
  json?: string
}

function serializePayload(type: SecretType, payload: SecretPayload): string {
  if (type === 'userpass') {
    if (!payload.userpass) throw new Error('userpass requires username and password')
    return JSON.stringify(payload.userpass)
  }
  if (type === 'value') {
    if (payload.value === undefined) throw new Error('value is required')
    return JSON.stringify({ value: payload.value })
  }
  if (type === 'json') {
    if (payload.json === undefined) throw new Error('json is required')
    // Validate it's actually JSON
    JSON.parse(payload.json)
    return JSON.stringify({ value: payload.json })
  }
  throw new Error('Unknown type')
}

const DUPLICATE_SECRET_ERROR = 'A secret with this name already exists in the vault'

/** Drizzle wraps driver errors ("Failed query: …"); the SQLite constraint text lives on `cause`. */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current.message.includes('UNIQUE constraint failed')) return true
  }
  return false
}

interface HashicorpRefBody { path?: unknown; key?: unknown }

/** Validates a HashiCorp secret reference from the request body. */
function parseReference(type: SecretType, body: HashicorpRefBody): { path: string; key?: string } {
  if (typeof body.path !== 'string' || !body.path.trim()) throw new HashicorpVaultError('Path is required')
  const path = body.path.trim().replace(/^\/+|\/+$/g, '')
  encodePath(path, 'Path')
  if (type !== 'value') return { path }
  if (typeof body.key !== 'string' || !body.key.trim()) throw new HashicorpVaultError('Key is required for a Secure Value')
  return { path, key: body.key.trim() }
}

/** Fails when Vault cannot serve the reference, so typos surface while the admin is still in the form. */
async function verifyReference(
  vault: typeof vaults.$inferSelect, type: SecretType, ref: { path: string; key?: string },
): Promise<void> {
  const kv = await readKvSecret(vault, ref.path)
  if (type === 'userpass' && (typeof kv['username'] !== 'string' || typeof kv['password'] !== 'string')) {
    throw new HashicorpVaultError('keys "username" and "password" are required at the path')
  }
  if (type === 'value' && (kv[ref.key!] === undefined || kv[ref.key!] === null)) {
    throw new HashicorpVaultError(`key "${ref.key}" not found`)
  }
}

/** Vault columns safe to return: never the encrypted connection. */
function publicVault(row: typeof vaults.$inferSelect) {
  const { connectionConfig: _cc, ...safe } = row
  return safe
}

/** Audit view of a HashiCorp connection; credentials are never included. */
function connectionAudit(row: typeof vaults.$inferSelect): Record<string, unknown> {
  if (row.type !== 'hashicorp') return { name: row.name, type: row.type }
  let c: ReturnType<typeof publicConnection>
  try {
    c = publicConnection(openConnection(row.connectionConfig))
  } catch {
    return { name: row.name, type: row.type } // connection undecryptable (key changed): still allow repair and delete
  }
  return { name: row.name, type: row.type, address: c.address, namespace: c.namespace, mount: c.mount, authMethod: c.authMethod, approleMount: c.approleMount, credentialsRef: c.credentialsRef }
}

function safeDecrypt(encryptedValue: string): unknown {
  try {
    return JSON.parse(decrypt(encryptedValue))
  } catch {
    return null
  }
}

/**
 * Read-only vault catalogue: vault and secret names/types, never values. Operators get it too so
 * they can pick a secret when configuring a monitor; creating, editing and revealing secrets stays
 * in {@link vaultRoutes} (admin only).
 */
export async function vaultCatalogRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    const rows = await db.select().from(vaults)
    return rows.map(publicVault)
  })

  app.get<{ Params: { id: string } }>('/:id/secrets', async (req, reply) => {
    const vaultId = Number(req.params.id)
    const vault = (await db.select().from(vaults).where(eq(vaults.id, vaultId)))[0]
    if (!vault) return reply.code(404).send({ error: 'Vault not found' })
    const secrets = await db
      .select({ id: vaultSecrets.id, vaultId: vaultSecrets.vaultId, name: vaultSecrets.name, type: vaultSecrets.type, createdAt: vaultSecrets.createdAt, updatedAt: vaultSecrets.updatedAt })
      .from(vaultSecrets)
      .where(eq(vaultSecrets.vaultId, vaultId))
    return secrets
  })
}

export async function vaultRoutes(app: FastifyInstance) {
  // ── Vaults ──────────────────────────────────────────────────────────────────

  app.post<{ Body: { name: string; description?: string; type?: string; connection?: unknown } }>('/', async (req, reply) => {
    if (!req.body.name?.trim()) return reply.code(400).send({ error: 'Name is required' })
    const type = req.body.type ?? 'local'
    if (type !== 'local' && type !== 'hashicorp') return reply.code(400).send({ error: 'Type must be local or hashicorp' })
    let connectionConfig: string | null = null
    if (type === 'hashicorp') {
      try {
        const cfg = parseConnection(req.body.connection)
        await verifyCredentialsRef(cfg)
        connectionConfig = sealConnection(cfg)
      } catch (e) {
        if (e instanceof HashicorpVaultError) return reply.code(400).send({ error: e.message })
        throw e
      }
    }
    const now = Date.now()
    const [row] = await db.insert(vaults).values({
      name: req.body.name.trim(),
      type,
      description: req.body.description?.trim() ?? null,
      connectionConfig,
      createdAt: now,
      updatedAt: now,
    }).returning()
    const actor = requestIdentity(req)
    writeAudit(auditActor(actor), 'create', 'vault', row!.id, row!.name, snapshot(connectionAudit(row!)))
    return publicVault(row!)
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const vault = (await db.select().from(vaults).where(eq(vaults.id, Number(req.params.id))))[0]
    if (!vault) return reply.code(404).send({ error: 'Vault not found' })
    if (vault.type !== 'hashicorp') return publicVault(vault)
    try {
      return { ...publicVault(vault), connection: publicConnection(openConnection(vault.connectionConfig)) }
    } catch (e) {
      if (e instanceof HashicorpVaultError) return reply.code(500).send({ error: e.message })
      throw e
    }
  })

  // Tests settings from the form before they are saved. With vaultId, blank credentials fall back to the saved ones
  // (parseConnection refuses that fallback when the connection target changed, so a saved secret never reaches a new server).
  app.post<{ Body: { vaultId?: number; connection?: unknown } }>('/test-connection', async (req, reply) => {
    let cfg: ReturnType<typeof parseConnection>
    try {
      let existing: ReturnType<typeof openConnection> | undefined
      if (req.body.vaultId !== undefined) {
        const vault = (await db.select().from(vaults).where(eq(vaults.id, Number(req.body.vaultId))))[0]
        if (!vault) return reply.code(404).send({ error: 'Vault not found' })
        if (vault.type !== 'hashicorp') return reply.code(400).send({ error: 'Only HashiCorp vaults have a connection to test' })
        try { existing = openConnection(vault.connectionConfig) } catch { /* undecryptable: full credentials required */ }
      }
      cfg = parseConnection(req.body.connection, existing)
      await verifyCredentialsRef(cfg)
    } catch (e) {
      if (e instanceof HashicorpVaultError) return reply.code(400).send({ error: e.message })
      throw e
    }
    try {
      return { ok: true, ...(await testDraftConnection(cfg)) }
    } catch (e) {
      if (e instanceof HashicorpVaultError) return reply.code(502).send({ error: e.message })
      throw e
    }
  })

  app.post<{ Params: { id: string } }>('/:id/test', async (req, reply) => {
    const vault = (await db.select().from(vaults).where(eq(vaults.id, Number(req.params.id))))[0]
    if (!vault) return reply.code(404).send({ error: 'Vault not found' })
    if (vault.type !== 'hashicorp') return reply.code(400).send({ error: 'Only HashiCorp vaults have a connection to test' })
    try {
      return { ok: true, ...(await testConnection(vault)) }
    } catch (e) {
      if (e instanceof HashicorpVaultError) return reply.code(502).send({ error: e.message })
      throw e
    }
  })

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string; connection?: unknown } }>(
    '/:id', async (req, reply) => {
      const id = Number(req.params.id)
      const existing = (await db.select().from(vaults).where(eq(vaults.id, id)))[0]
      if (!existing) return reply.code(404).send({ error: 'Vault not found' })
      const updates: Record<string, unknown> = { updatedAt: Date.now() }
      if (req.body.name !== undefined) updates['name'] = req.body.name.trim()
      if (req.body.description !== undefined) updates['description'] = req.body.description.trim() || null
      let credentialsChanged = false
      if (req.body.connection !== undefined) {
        if (existing.type !== 'hashicorp') return reply.code(400).send({ error: 'Only HashiCorp vaults have connection settings' })
        try {
          let old: ReturnType<typeof openConnection> | undefined
          try { old = openConnection(existing.connectionConfig) } catch { /* undecryptable: full credentials required */ }
          const next = parseConnection(req.body.connection, old)
          await verifyCredentialsRef(next)
          credentialsChanged = old?.token !== next.token || old?.roleId !== next.roleId || old?.secretId !== next.secretId
          updates['connectionConfig'] = sealConnection(next)
        } catch (e) {
          if (e instanceof HashicorpVaultError) return reply.code(400).send({ error: e.message })
          throw e
        }
      }
      const [row] = await db.update(vaults).set(updates).where(eq(vaults.id, id)).returning()
      forgetHashicorpVault(id)
      const actor = requestIdentity(req)
      const before = { ...connectionAudit(existing), description: existing.description }
      const after  = { ...connectionAudit(row!), description: row!.description }
      const diff = diffObjects(before, after)
      if (credentialsChanged) diff['credentials'] = { from: '[redacted]', to: '[redacted]' }
      if (Object.keys(diff).length) writeAudit(auditActor(actor), 'update', 'vault', id, existing.name, diff)
      return publicVault(row!)
    },
  )

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(vaults).where(eq(vaults.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Vault not found' })
    await db.delete(vaults).where(eq(vaults.id, id))
    forgetHashicorpVault(id)
    forgetCredentialDependents(id)
    const actor = requestIdentity(req)
    writeAudit(auditActor(actor), 'delete', 'vault', id, existing.name, snapshot(connectionAudit(existing)))
    return reply.code(204).send()
  })

  // ── Secrets ─────────────────────────────────────────────────────────────────

  app.post<{ Params: { id: string }; Body: { name: string; type: string } & SecretPayload & HashicorpRefBody }>(
    '/:id/secrets', async (req, reply) => {
      const vaultId = Number(req.params.id)
      const vault = (await db.select().from(vaults).where(eq(vaults.id, vaultId)))[0]
      if (!vault) return reply.code(404).send({ error: 'Vault not found' })
      if (!req.body.name?.trim()) return reply.code(400).send({ error: 'Name is required' })
      if (!VALID_SECRET_TYPES.includes(req.body.type as SecretType)) {
        return reply.code(400).send({ error: `Type must be one of: ${VALID_SECRET_TYPES.join(', ')}` })
      }
      const type = req.body.type as SecretType
      let plaintext: string
      let reference: { path: string; key?: string } | undefined
      try {
        if (vault.type === 'hashicorp') {
          reference = parseReference(type, req.body)
          await verifyReference(vault, type, reference)
          plaintext = JSON.stringify(reference)
        } else {
          plaintext = serializePayload(type, req.body)
        }
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message })
      }
      const now = Date.now()
      try {
        const [row] = await db.insert(vaultSecrets).values({
          vaultId,
          name: req.body.name.trim(),
          type,
          encryptedValue: encrypt(plaintext),
          createdAt: now,
          updatedAt: now,
        }).returning()
        const actor = requestIdentity(req)
        writeAudit(auditActor(actor), 'create', 'vault_secret', row!.id, `${vault.name} / ${row!.name}`,
          snapshot({ name: row!.name, type: row!.type, vault: vault.name, ...(reference && { path: reference.path, key: reference.key }) }))
        // Return without encrypted value
        const { encryptedValue: _ev, ...safe } = row!
        return safe
      } catch (e: unknown) {
        if (isUniqueViolation(e)) return reply.code(409).send({ error: DUPLICATE_SECRET_ERROR })
        throw e
      }
    },
  )

  app.patch<{ Params: { id: string; secretId: string }; Body: { name?: string } & SecretPayload & HashicorpRefBody }>(
    '/:id/secrets/:secretId', async (req, reply) => {
      const vaultId = Number(req.params.id)
      const secretId = Number(req.params.secretId)
      const secret = (await db.select().from(vaultSecrets).where(
        and(eq(vaultSecrets.id, secretId), eq(vaultSecrets.vaultId, vaultId)),
      ))[0]
      if (!secret) return reply.code(404).send({ error: 'Secret not found' })

      const updates: Record<string, unknown> = { updatedAt: Date.now() }
      if (req.body.name !== undefined) updates['name'] = req.body.name.trim()

      // Re-encrypt if any secret field provided
      const vaultForSecret = (await db.select().from(vaults).where(eq(vaults.id, vaultId)))[0]!
      const isReference = vaultForSecret.type === 'hashicorp'
      const hasNewValue = isReference
        ? req.body.path !== undefined || req.body.key !== undefined
        : req.body.userpass !== undefined || req.body.value !== undefined || req.body.json !== undefined
      if (hasNewValue) {
        try {
          if (isReference) {
            const old = JSON.parse(decrypt(secret.encryptedValue)) as { path: string; key?: string }
            const ref = parseReference(secret.type as SecretType, { path: req.body.path ?? old.path, key: req.body.key ?? old.key })
            await verifyReference(vaultForSecret, secret.type as SecretType, ref)
            updates['encryptedValue'] = encrypt(JSON.stringify(ref))
          } else {
            updates['encryptedValue'] = encrypt(serializePayload(secret.type as SecretType, req.body))
          }
        } catch (e) {
          return reply.code(400).send({ error: (e as Error).message })
        }
      }

      try {
        const [row] = await db.update(vaultSecrets).set(updates).where(eq(vaultSecrets.id, secretId)).returning()
        forgetCredentialDependents(vaultId, secretId)
        const actor = requestIdentity(req)
        const vaultRow = (await db.select().from(vaults).where(eq(vaults.id, vaultId)))[0]
        const diff: Record<string, unknown> = {}
        if (req.body.name !== undefined && req.body.name !== secret.name) diff['name'] = { from: secret.name, to: req.body.name }
        if (hasNewValue) diff[isReference ? 'reference' : 'value'] = { from: '[redacted]', to: '[redacted]' }
        if (Object.keys(diff).length) writeAudit(auditActor(actor), 'update', 'vault_secret', secretId, `${vaultRow?.name ?? vaultId} / ${secret.name}`, diff)
        const { encryptedValue: _ev, ...safe } = row!
        return safe
      } catch (e: unknown) {
        if (isUniqueViolation(e)) return reply.code(409).send({ error: DUPLICATE_SECRET_ERROR })
        throw e
      }
    },
  )

  app.delete<{ Params: { id: string; secretId: string } }>(
    '/:id/secrets/:secretId', async (req, reply) => {
      const vaultId = Number(req.params.id)
      const secretId = Number(req.params.secretId)
      const secret = (await db.select().from(vaultSecrets).where(
        and(eq(vaultSecrets.id, secretId), eq(vaultSecrets.vaultId, vaultId)),
      ))[0]
      if (!secret) return reply.code(404).send({ error: 'Secret not found' })
      await db.delete(vaultSecrets).where(eq(vaultSecrets.id, secretId))
      forgetCredentialDependents(vaultId, secretId)
      const actor = requestIdentity(req)
      const vaultRow = (await db.select().from(vaults).where(eq(vaults.id, vaultId)))[0]
      writeAudit(auditActor(actor), 'delete', 'vault_secret', secretId, `${vaultRow?.name ?? vaultId} / ${secret.name}`,
        snapshot({ name: secret.name, type: secret.type }))
      return reply.code(204).send()
    },
  )

  app.get<{ Params: { id: string; secretId: string } }>(
    '/:id/secrets/:secretId/reveal', async (req, reply) => {
      const vaultId = Number(req.params.id)
      const secretId = Number(req.params.secretId)
      const secret = (await db.select().from(vaultSecrets).where(
        and(eq(vaultSecrets.id, secretId), eq(vaultSecrets.vaultId, vaultId)),
      ))[0]
      if (!secret) return reply.code(404).send({ error: 'Secret not found' })
      const vault = (await db.select().from(vaults).where(eq(vaults.id, vaultId)))[0]!
      if (vault.type === 'hashicorp') {
        const ref = safeDecrypt(secret.encryptedValue) as { path: string; key?: string } | null
        if (!ref) return reply.code(500).send({ error: 'Failed to decrypt secret' })
        try {
          const value = await loadSecretPayload(secret, vault)
          return { id: secret.id, name: secret.name, type: secret.type, value, source: ref }
        } catch (e) {
          return reply.code(502).send({ error: (e as Error).message })
        }
      }
      const value = safeDecrypt(secret.encryptedValue)
      if (value === null) return reply.code(500).send({ error: 'Failed to decrypt secret' })
      return { id: secret.id, name: secret.name, type: secret.type, value }
    },
  )
}
