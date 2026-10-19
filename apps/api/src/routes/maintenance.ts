import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { maintenanceWindows, maintenanceWindowMonitors, monitors } from '../db/schema.js'
import { eq, inArray } from 'drizzle-orm'
import { auditActor, writeAudit, diffObjects, snapshot } from '../kit/audit.js'
import { requestIdentity } from '../kit/authMiddleware.js'
import { notifyMaintenanceSubscribers } from '../workers/subscriberNotifier.js'
import { activeWindows, maxOccurrenceMs, parseRecurrenceDays, shownOccurrence, windowOccurrences } from '../services/maintenanceSchedule.js'
import { isValidTimezone } from '../services/alertPolicy.js'
import type { MaintenanceRecurrence } from '@bsp/shared'

async function withMonitorIds(win: typeof maintenanceWindows.$inferSelect) {
  const links = await db.select().from(maintenanceWindowMonitors).where(eq(maintenanceWindowMonitors.windowId, win.id))
  return {
    ...win,
    recurrenceDays: parseRecurrenceDays(win.recurrenceDays),
    occurrence: shownOccurrence(win, Date.now()),
    monitorIds: links.map((l) => l.monitorId),
  }
}

type StoredRecurrence = { recurrence?: string; recurrenceDays?: string | null; timezone?: string; recurrenceUntil?: number | null }

type Recurrence = {
  recurrence?: unknown
  recurrenceDays?: unknown
  timezone?: unknown
  recurrenceUntil?: unknown
}

const RECURRENCES: readonly string[] = ['none', 'daily', 'weekly'] satisfies MaintenanceRecurrence[]
const isWeekday = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6

/**
 * Recurrence columns of a create or update body laid over the stored window. Days and end only mean something
 * for the kind that uses them, so the others are cleared.
 */
function recurrenceColumns(body: Recurrence, current: StoredRecurrence) {
  const recurrence = (body.recurrence ?? current.recurrence ?? 'none') as MaintenanceRecurrence
  const days = body.recurrenceDays !== undefined ? (body.recurrenceDays as number[]) : parseRecurrenceDays(current.recurrenceDays ?? null)
  return {
    recurrence,
    recurrenceDays: recurrence === 'weekly' ? [...new Set(days)].sort().join(',') : null,
    timezone: (body.timezone ?? current.timezone ?? 'UTC') as string,
    recurrenceUntil: recurrence === 'none' ? null : ((body.recurrenceUntil !== undefined ? body.recurrenceUntil : current.recurrenceUntil) ?? null) as number | null,
  }
}

const MAX_NAME_LENGTH = 200
const MAX_MONITOR_IDS = 1_000
const isEpochMs = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/**
 * The first problem with a create or update body, or null. `current` is the stored window of an update, so a body
 * that moves only one end is checked against the other. Fields left out are not checked (an update) or required
 * (a create, where `required` is set).
 */
async function windowProblem(
  body: { name?: unknown; startsAt?: unknown; endsAt?: unknown; description?: unknown; monitorIds?: unknown } & Recurrence,
  current: ({ startsAt: number; endsAt: number } & StoredRecurrence) | null,
): Promise<string | null> {
  const required = current === null
  if (body.name !== undefined || required) {
    if (typeof body.name !== 'string' || !body.name.trim()) return 'Name is required'
    if (body.name.length > MAX_NAME_LENGTH) return `Name must be at most ${MAX_NAME_LENGTH} characters`
  }
  for (const field of ['startsAt', 'endsAt'] as const) {
    if ((body[field] !== undefined || required) && !isEpochMs(body[field])) return `${field} must be a timestamp in milliseconds`
  }
  const startsAt = (body.startsAt ?? current?.startsAt) as number
  const endsAt = (body.endsAt ?? current?.endsAt) as number
  if (endsAt <= startsAt) return 'endsAt must be after startsAt'
  const recurrence = recurrenceColumns(body, current ?? {})
  if (!RECURRENCES.includes(recurrence.recurrence)) return 'recurrence must be none, daily or weekly'
  const days = body.recurrenceDays !== undefined ? body.recurrenceDays : parseRecurrenceDays(current?.recurrenceDays ?? null)
  if (recurrence.recurrence === 'weekly' && (!Array.isArray(days) || days.length === 0 || !days.every(isWeekday))) {
    return 'recurrenceDays must list weekdays from 0 (Sunday) to 6'
  }
  if (typeof recurrence.timezone !== 'string' || !isValidTimezone(recurrence.timezone)) return 'timezone must be an IANA timezone'
  if (recurrence.recurrenceUntil !== null && !isEpochMs(recurrence.recurrenceUntil)) return 'recurrenceUntil must be a timestamp in milliseconds'
  if (recurrence.recurrenceUntil !== null && recurrence.recurrenceUntil < startsAt) return 'recurrenceUntil must not be before startsAt'
  // Occurrences must not overlap: ending one early could not stop the other.
  if (endsAt - startsAt > maxOccurrenceMs(recurrence.recurrence, recurrence.recurrence === 'weekly' ? (days as number[]) : [])) {
    return recurrence.recurrence === 'daily'
      ? 'A daily window can last at most 23 hours'
      : 'A weekly window can last at most an hour less than the shortest gap between its weekdays'
  }
  if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') return 'description must be text'
  if (body.monitorIds !== undefined) {
    const ids = body.monitorIds
    if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) return 'monitorIds must be a list of monitor ids'
    if (ids.length > MAX_MONITOR_IDS) return `monitorIds can name at most ${MAX_MONITOR_IDS} monitors`
    const unique = [...new Set(ids as number[])]
    if (unique.length > 0) {
      const known = await db.select({ id: monitors.id }).from(monitors).where(inArray(monitors.id, unique))
      if (known.length !== unique.length) return 'Unknown monitor'
    }
  }
  return null
}

export async function maintenanceRoutes(app: FastifyInstance) {
  // List all maintenance windows
  app.get('/', async () => {
    const rows = await db.select().from(maintenanceWindows)
    return Promise.all(rows.map(withMonitorIds))
  })

  // Get active windows (now is between starts_at and ends_at)
  app.get('/active', async () => {
    return Promise.all((await activeWindows(Date.now())).map(withMonitorIds))
  })

  // Get single window
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = (await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, Number(req.params.id))))[0]
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return withMonitorIds(row)
  })

  // Create window
  app.post<{ Body: {
    name: string
    startsAt: number
    endsAt: number
    description?: string
    recurrence?: MaintenanceRecurrence
    recurrenceDays?: number[]
    timezone?: string
    recurrenceUntil?: number | null
    monitorIds?: number[]
    notifySubscribers?: boolean
  } }>('/', async (req, reply) => {
    const problem = await windowProblem(req.body ?? {}, null)
    if (problem) return reply.code(400).send({ error: problem })
    const now = Date.now()
    const { name, startsAt, endsAt, description, notifySubscribers = true } = req.body
    const monitorIds = [...new Set(req.body.monitorIds ?? [])]
    const results = await db.insert(maintenanceWindows).values({
      name,
      startsAt,
      endsAt,
      description: description ?? null,
      ...recurrenceColumns(req.body, {}),
      createdAt: now,
      updatedAt: now,
    }).returning()
    const win = results[0]!
    if (monitorIds.length > 0) {
      await db.insert(maintenanceWindowMonitors).values(
        monitorIds.map((mid) => ({ windowId: win.id, monitorId: mid })),
      )
    }
    const actor = requestIdentity(req)
    writeAudit(auditActor(actor), 'create', 'maintenance', win.id, win.name,
      snapshot({ name: win.name, startsAt: win.startsAt, endsAt: win.endsAt, recurrence: win.recurrence, monitorIds }))
    // Announcing a window with no occurrence left would only be noise.
    const { current, next } = windowOccurrences(win, now)
    if (notifySubscribers && (current || next)) {
      await notifyMaintenanceSubscribers(win.id)
        .catch((error) => console.error('[subscriptions] Failed to queue maintenance notice:', error))
    }
    return withMonitorIds(win)
  })

  // Update window
  app.patch<{ Params: { id: string }; Body: Partial<{
    name: string
    startsAt: number
    endsAt: number
    description: string | null
    recurrence: MaintenanceRecurrence
    recurrenceDays: number[]
    timezone: string
    recurrenceUntil: number | null
    monitorIds: number[]
  }> }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    if (typeof req.body !== 'object' || req.body === null) return reply.code(400).send({ error: 'Body must be an object' })
    const problem = await windowProblem(req.body, existing)
    if (problem) return reply.code(400).send({ error: problem })

    const updates: Partial<typeof maintenanceWindows.$inferInsert> = { updatedAt: Date.now() }
    if (req.body.name !== undefined) updates.name = req.body.name
    if (req.body.startsAt !== undefined) updates.startsAt = req.body.startsAt
    if (req.body.endsAt !== undefined) updates.endsAt = req.body.endsAt
    if ('description' in req.body) updates.description = req.body.description ?? null
    // An early end stays: it only matches the occurrence that starts at exactly the instant that was ended.
    Object.assign(updates, recurrenceColumns(req.body, existing))

    const results = await db.update(maintenanceWindows).set(updates).where(eq(maintenanceWindows.id, id)).returning()
    const win = results[0]!

    if (req.body.monitorIds !== undefined) {
      await db.delete(maintenanceWindowMonitors).where(eq(maintenanceWindowMonitors.windowId, id))
      if (req.body.monitorIds.length > 0) {
        await db.insert(maintenanceWindowMonitors).values(
          [...new Set(req.body.monitorIds)].map((mid) => ({ windowId: id, monitorId: mid })),
        )
      }
    }

    const actor = requestIdentity(req)
    const audited = (w: typeof win) => ({
      name: w.name, startsAt: w.startsAt, endsAt: w.endsAt,
      recurrence: w.recurrence, recurrenceDays: w.recurrenceDays, timezone: w.timezone, recurrenceUntil: w.recurrenceUntil,
    }) as Record<string, unknown>
    const before = audited(existing)
    const after  = audited(win)
    const diff = diffObjects(before, after)
    if (req.body.monitorIds !== undefined) diff['monitorIds'] = { from: '[previous]', to: req.body.monitorIds }
    if (Object.keys(diff).length) writeAudit(auditActor(actor), 'update', 'maintenance', id, existing.name, diff)
    return withMonitorIds(win)
  })

  // End the running occurrence now. A repeating window keeps its later occurrences.
  app.post<{ Params: { id: string } }>('/:id/end', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    const now = Date.now()
    const running = windowOccurrences(existing, now).current
    if (!running) return reply.code(409).send({ error: 'Maintenance window is not running' })
    const updates: Partial<typeof maintenanceWindows.$inferInsert> = { updatedAt: now }
    if (existing.recurrence === 'none') updates.endsAt = Math.max(now, existing.startsAt + 1)
    else Object.assign(updates, { endedEarlyStart: running.startsAt, endedEarlyAt: now })
    const win = (await db.update(maintenanceWindows).set(updates).where(eq(maintenanceWindows.id, id)).returning())[0]!
    writeAudit(auditActor(requestIdentity(req)), 'update', 'maintenance', id, existing.name,
      { endedEarly: { from: new Date(running.endsAt).toISOString(), to: new Date(now).toISOString() } })
    return withMonitorIds(win)
  })

  // Delete window
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, id)))[0]
    await db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, id))
    if (existing) {
      const actor = requestIdentity(req)
      writeAudit(auditActor(actor), 'delete', 'maintenance', id, existing.name,
        snapshot({ name: existing.name }))
    }
    return reply.code(204).send()
  })
}
