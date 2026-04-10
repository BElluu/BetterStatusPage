import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { notificationChannels, monitorNotificationChannels, smtpSettings } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { testNotificationChannel } from '../workers/notifier.js'

export async function notificationRoutes(app: FastifyInstance) {
  // ── Channels CRUD ──────────────────────────────────────────────────────────

  app.get('/channels', async () => {
    const rows = await db.select().from(notificationChannels)
    return rows.map((r) => ({ ...r, config: JSON.parse(r.config) }))
  })

  app.post<{ Body: {
    name: string; type: string
    config: unknown; enabled?: number; notifyOnRecovery?: number
  } }>('/channels', async (req) => {
    const now = Date.now()
    const results = await db.insert(notificationChannels).values({
      name: req.body.name,
      type: req.body.type,
      config: JSON.stringify(req.body.config ?? {}),
      enabled: req.body.enabled ?? 1,
      notifyOnRecovery: req.body.notifyOnRecovery ?? 0,
      createdAt: now,
      updatedAt: now,
    }).returning()
    const r = results[0]!
    return { ...r, config: JSON.parse(r.config) }
  })

  app.get<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
    const r = (await db.select().from(notificationChannels).where(eq(notificationChannels.id, Number(req.params.id))))[0]
    if (!r) return reply.code(404).send({ error: 'Not found' })
    return { ...r, config: JSON.parse(r.config) }
  })

  app.patch<{ Params: { id: string }; Body: Partial<{
    name: string; type: string; config: unknown; enabled: number; notifyOnRecovery: number
  }> }>('/channels/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(notificationChannels).where(eq(notificationChannels.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const updates: Partial<typeof notificationChannels.$inferInsert> = { updatedAt: Date.now() }
    if (req.body.name !== undefined)              updates.name = req.body.name
    if (req.body.type !== undefined)              updates.type = req.body.type
    if (req.body.config !== undefined)            updates.config = JSON.stringify(req.body.config)
    if (req.body.enabled !== undefined)           updates.enabled = req.body.enabled
    if (req.body.notifyOnRecovery !== undefined)  updates.notifyOnRecovery = req.body.notifyOnRecovery

    const results = await db.update(notificationChannels).set(updates).where(eq(notificationChannels.id, id)).returning()
    const r = results[0]!
    return { ...r, config: JSON.parse(r.config) }
  })

  app.delete<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
    await db.delete(monitorNotificationChannels).where(eq(monitorNotificationChannels.channelId, Number(req.params.id)))
    await db.delete(notificationChannels).where(eq(notificationChannels.id, Number(req.params.id)))
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string } }>('/channels/:id/test', async (req, reply) => {
    const result = await testNotificationChannel(Number(req.params.id))
    if (!result.ok) return reply.code(422).send({ error: result.error })
    return { ok: true }
  })

  // ── Monitor ↔ Channel links ────────────────────────────────────────────────

  app.get<{ Params: { monitorId: string } }>('/monitor/:monitorId/channels', async (req) => {
    const links = await db.select().from(monitorNotificationChannels)
      .where(eq(monitorNotificationChannels.monitorId, Number(req.params.monitorId)))
    return links.map((l) => l.channelId)
  })

  app.put<{ Params: { monitorId: string }; Body: { channelIds: number[] } }>('/monitor/:monitorId/channels', async (req) => {
    const monitorId = Number(req.params.monitorId)
    await db.delete(monitorNotificationChannels).where(eq(monitorNotificationChannels.monitorId, monitorId))
    if (req.body.channelIds.length > 0) {
      await db.insert(monitorNotificationChannels).values(
        req.body.channelIds.map((channelId) => ({ monitorId, channelId })),
      )
    }
    return { ok: true }
  })

  // ── SMTP Settings ──────────────────────────────────────────────────────────

  app.get('/smtp', async () => {
    const row = (await db.select().from(smtpSettings))[0]
    if (!row) return { host: '', port: 587, secure: 0, user: '', password: '', fromAddress: '', fromName: 'BSP Alerts', vault: null, updatedAt: 0 }
    return {
      ...row,
      password: row.password ? '••••••••' : '',
      vault: row.vaultConfig ? JSON.parse(row.vaultConfig) : null,
    }
  })

  app.put<{ Body: {
    host: string; port: number; secure: number
    user: string; password?: string; fromAddress: string; fromName: string
    vault?: { vaultId: number; secretId: number; fieldMapping?: Record<string, string> } | null
  } }>('/smtp', async (req) => {
    const now = Date.now()
    const existing = (await db.select().from(smtpSettings))[0]

    const values = {
      host: req.body.host,
      port: req.body.port,
      secure: req.body.secure,
      user: req.body.vault ? '' : (req.body.user ?? ''),
      fromAddress: req.body.fromAddress,
      fromName: req.body.fromName,
      vaultConfig: req.body.vault ? JSON.stringify(req.body.vault) : null,
      updatedAt: now,
    }

    if (existing) {
      // Only update password if a new one was provided and not using vault
      const password = req.body.vault
        ? ''
        : (req.body.password && req.body.password !== '••••••••' ? req.body.password : existing.password)
      await db.update(smtpSettings).set({ ...values, password }).where(eq(smtpSettings.id, 1))
    } else {
      await db.insert(smtpSettings).values({ id: 1, ...values, password: req.body.vault ? '' : (req.body.password ?? '') })
    }

    return { ok: true }
  })

  app.post<{ Body: { to: string } }>('/smtp/test', async (req, reply) => {
    const { to } = req.body
    if (!to) return reply.code(400).send({ error: 'Recipient address required' })
    const { testSmtp } = await import('../workers/notifier.js')
    const result = await testSmtp(to)
    if (!result.ok) return reply.code(422).send({ error: result.error })
    return { ok: true }
  })
}
