import type { FastifyInstance } from 'fastify'
import { and, asc, eq, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import { incidentTemplates, monitors } from '../db/schema.js'
import { auditActor, writeAudit, diffObjects, snapshot } from '../services/audit.js'
import { requestIdentity } from '../middleware/auth.js'

const VALID_IMPACTS = ['minor', 'major', 'critical'] as const
const MAX_NAME = 100
const MAX_TITLE = 200
const MAX_BODY = 5_000

type Fields = { name: string; title: string; body: string; resolvedBody: string; impact: string }
type Input = Partial<Record<keyof Fields, unknown>>

function parseText(value: unknown, field: string, max: number): { value: string } | { error: string } {
  if (typeof value !== 'string' || !value.trim()) return { error: `${field} is required` }
  if (value.length > max) return { error: `${field} must be at most ${max} characters` }
  return { value }
}

/** Validates the fields present in `input`; `requireAll` is for creation, where every field is needed. */
function parseFields(input: Input, requireAll: boolean): { value: Partial<Fields> } | { error: string } {
  const out: Partial<Fields> = {}
  for (const [field, max] of [['name', MAX_NAME], ['title', MAX_TITLE], ['body', MAX_BODY], ['resolvedBody', MAX_BODY]] as const) {
    if (input[field] === undefined && !requireAll) continue
    const parsed = parseText(input[field], field, max)
    if ('error' in parsed) return parsed
    out[field] = parsed.value
  }
  if (input.impact !== undefined || requireAll) {
    if (!VALID_IMPACTS.includes(input.impact as typeof VALID_IMPACTS[number])) {
      return { error: `Invalid impact. Must be one of: ${VALID_IMPACTS.join(', ')}` }
    }
    out.impact = input.impact as string
  }
  return { value: out }
}

/** Names identify a template in configuration files, so two templates cannot share one. */
async function nameTaken(name: string, exceptId?: number): Promise<boolean> {
  const rows = await db.select({ id: incidentTemplates.id }).from(incidentTemplates)
    .where(exceptId === undefined ? eq(incidentTemplates.name, name) : and(eq(incidentTemplates.name, name), ne(incidentTemplates.id, exceptId)))
  return rows.length > 0
}

const present = (row: typeof incidentTemplates.$inferSelect) => ({ ...row, isDefault: !!row.isDefault })

export async function incidentTemplateRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    const rows = await db.select().from(incidentTemplates).orderBy(asc(incidentTemplates.name))
    return rows.map(present)
  })

  app.post<{ Body: Input }>('/', async (req, reply) => {
    const parsed = parseFields(req.body ?? {}, true)
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error })
    if (await nameTaken(parsed.value.name!)) return reply.code(409).send({ error: 'A template with this name already exists' })
    const now = Date.now()
    const row = (await db.insert(incidentTemplates).values({ ...(parsed.value as Fields), isDefault: 0, createdAt: now, updatedAt: now }).returning())[0]!
    writeAudit(auditActor(requestIdentity(req)), 'create', 'incident_template', row.id, row.name, snapshot({ name: row.name, title: row.title, impact: row.impact }))
    return present(row)
  })

  app.patch<{ Params: { id: string }; Body: Input }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(incidentTemplates).where(eq(incidentTemplates.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    const parsed = parseFields(req.body ?? {}, false)
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error })
    if (parsed.value.name !== undefined && await nameTaken(parsed.value.name, id)) return reply.code(409).send({ error: 'A template with this name already exists' })
    const row = (await db.update(incidentTemplates).set({ ...parsed.value, updatedAt: Date.now() }).where(eq(incidentTemplates.id, id)).returning())[0]!
    const pick = (t: typeof row) => ({ name: t.name, title: t.title, body: t.body, resolvedBody: t.resolvedBody, impact: t.impact }) as Record<string, unknown>
    const diff = diffObjects(pick(existing), pick(row))
    if (Object.keys(diff).length) writeAudit(auditActor(requestIdentity(req)), 'update', 'incident_template', id, existing.name, diff)
    return present(row)
  })

  // The default template is what automatic incidents fall back to, so it can be edited but not removed.
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(incidentTemplates).where(eq(incidentTemplates.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    if (existing.isDefault) return reply.code(409).send({ error: 'The default template cannot be deleted' })
    // Monitors that used it fall back to the default template.
    await db.update(monitors).set({ autoIncidentTemplateId: null }).where(eq(monitors.autoIncidentTemplateId, id))
    await db.delete(incidentTemplates).where(eq(incidentTemplates.id, id))
    writeAudit(auditActor(requestIdentity(req)), 'delete', 'incident_template', id, existing.name, snapshot({ name: existing.name }))
    return reply.code(204).send()
  })
}
