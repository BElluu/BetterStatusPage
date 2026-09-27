import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { vaults, vaultSecrets } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'
import { encrypt, decrypt } from '../crypto/vault.js'
import { auditActor, writeAudit, diffObjects, snapshot } from '../services/audit.js'
import { requestIdentity } from '../middleware/auth.js'

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
    return rows
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

  app.post<{ Body: { name: string; description?: string } }>('/', async (req, reply) => {
    if (!req.body.name?.trim()) return reply.code(400).send({ error: 'Name is required' })
    const now = Date.now()
    const [row] = await db.insert(vaults).values({
      name: req.body.name.trim(),
      type: 'local',
      description: req.body.description?.trim() ?? null,
      createdAt: now,
      updatedAt: now,
    }).returning()
    const actor = requestIdentity(req)
    writeAudit(auditActor(actor), 'create', 'vault', row!.id, row!.name,
      snapshot({ name: row!.name }))
    return row
  })

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string } }>(
    '/:id', async (req, reply) => {
      const id = Number(req.params.id)
      const existing = (await db.select().from(vaults).where(eq(vaults.id, id)))[0]
      if (!existing) return reply.code(404).send({ error: 'Vault not found' })
      const updates: Record<string, unknown> = { updatedAt: Date.now() }
      if (req.body.name !== undefined) updates['name'] = req.body.name.trim()
      if (req.body.description !== undefined) updates['description'] = req.body.description.trim() || null
      const [row] = await db.update(vaults).set(updates).where(eq(vaults.id, id)).returning()
      const actor = requestIdentity(req)
      const before = { name: existing.name, description: existing.description } as Record<string, unknown>
      const after  = { name: row!.name, description: row!.description } as Record<string, unknown>
      const diff = diffObjects(before, after)
      if (Object.keys(diff).length) writeAudit(auditActor(actor), 'update', 'vault', id, existing.name, diff)
      return row
    },
  )

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(vaults).where(eq(vaults.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Vault not found' })
    await db.delete(vaults).where(eq(vaults.id, id))
    const actor = requestIdentity(req)
    writeAudit(auditActor(actor), 'delete', 'vault', id, existing.name,
      snapshot({ name: existing.name }))
    return reply.code(204).send()
  })

  // ── Secrets ─────────────────────────────────────────────────────────────────

  app.post<{ Params: { id: string }; Body: { name: string; type: string } & SecretPayload }>(
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
      try {
        plaintext = serializePayload(type, req.body)
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
          snapshot({ name: row!.name, type: row!.type, vault: vault.name }))
        // Return without encrypted value
        const { encryptedValue: _ev, ...safe } = row!
        return safe
      } catch (e: unknown) {
        if (isUniqueViolation(e)) return reply.code(409).send({ error: DUPLICATE_SECRET_ERROR })
        throw e
      }
    },
  )

  app.patch<{ Params: { id: string; secretId: string }; Body: { name?: string } & SecretPayload }>(
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
      const hasNewValue = req.body.userpass !== undefined || req.body.value !== undefined || req.body.json !== undefined
      if (hasNewValue) {
        try {
          const plaintext = serializePayload(secret.type as SecretType, req.body)
          updates['encryptedValue'] = encrypt(plaintext)
        } catch (e) {
          return reply.code(400).send({ error: (e as Error).message })
        }
      }

      try {
        const [row] = await db.update(vaultSecrets).set(updates).where(eq(vaultSecrets.id, secretId)).returning()
        const actor = requestIdentity(req)
        const vaultRow = (await db.select().from(vaults).where(eq(vaults.id, vaultId)))[0]
        const diff: Record<string, unknown> = {}
        if (req.body.name !== undefined && req.body.name !== secret.name) diff['name'] = { from: secret.name, to: req.body.name }
        if (hasNewValue) diff['value'] = { from: '[redacted]', to: '[redacted]' }
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
      const value = safeDecrypt(secret.encryptedValue)
      if (value === null) return reply.code(500).send({ error: 'Failed to decrypt secret' })
      return { id: secret.id, name: secret.name, type: secret.type, value }
    },
  )
}
