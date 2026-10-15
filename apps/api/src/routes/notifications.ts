import type { FastifyInstance } from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { monitors, notificationChannels, monitorNotificationChannels } from '../db/schema.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { notifyRoutes } from '../kit/notifyRoutes.js'

/** The notification routes of the notify module, plus the links between monitors and their channels. */
export async function notificationRoutes(app: FastifyInstance) {
  await app.register(notifyRoutes)

  // ── Monitor ↔ Channel links ────────────────────────────────────────────

  app.get<{ Params: { monitorId: string } }>('/monitor/:monitorId/channels', async (req) => {
    const links = await db.select().from(monitorNotificationChannels)
      .where(eq(monitorNotificationChannels.monitorId, Number(req.params.monitorId)))
    return links.map((l) => l.channelId)
  })

  app.put<{ Params: { monitorId: string }; Body: { channelIds: number[] } }>('/monitor/:monitorId/channels', async (req, reply) => {
    const monitorId = Number(req.params.monitorId)
    if (!Number.isSafeInteger(monitorId) || monitorId <= 0) return reply.code(400).send({ error: 'Invalid monitor id' })
    const monitor = (await db.select({ id: monitors.id }).from(monitors).where(eq(monitors.id, monitorId)))[0]
    if (!monitor) return reply.code(404).send({ error: 'Monitor not found' })
    const channelIds = req.body?.channelIds
    if (!Array.isArray(channelIds) || !channelIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
      return reply.code(400).send({ error: 'channelIds must be an array of channel ids' })
    }
    const uniqueIds = [...new Set(channelIds)]
    if (uniqueIds.length > 0) {
      // The link table has no foreign key, so unknown ids would be stored silently.
      const known = await db.select({ id: notificationChannels.id }).from(notificationChannels).where(inArray(notificationChannels.id, uniqueIds))
      if (known.length !== uniqueIds.length) return reply.code(400).send({ error: 'Unknown notification channel' })
    }
    // Replace the links atomically so a failed insert never leaves the monitor without channels.
    await withImmediateTransaction(async () => {
      await db.delete(monitorNotificationChannels).where(eq(monitorNotificationChannels.monitorId, monitorId))
      if (uniqueIds.length > 0) {
        await db.insert(monitorNotificationChannels).values(uniqueIds.map((channelId) => ({ monitorId, channelId })))
      }
    })
    return { ok: true }
  })
}
