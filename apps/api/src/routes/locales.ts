import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { locales } from '../db/schema.js'
import { eq } from 'drizzle-orm'

function parseLocale(row: typeof locales.$inferSelect) {
  return {
    ...row,
    translations: JSON.parse(row.translations || '{}'),
  }
}

export async function publicLocaleRoutes(app: FastifyInstance) {
  // List available locales
  app.get('/', async () => {
    const rows = await db
      .select({ code: locales.code, name: locales.name, isDefault: locales.isDefault })
      .from(locales)
      .orderBy(locales.name)
    return rows
  })

  // Get translations for a specific locale
  app.get<{ Params: { code: string } }>('/:code', async (req, reply) => {
    const row = (await db.select().from(locales).where(eq(locales.code, req.params.code)))[0]
    if (!row) return reply.code(404).send({ error: 'Locale not found' })
    return {
      code: row.code,
      name: row.name,
      translations: JSON.parse(row.translations || '{}'),
    }
  })
}

export async function adminLocaleRoutes(app: FastifyInstance) {
  // List all locales with full data
  app.get('/', async () => {
    const rows = await db.select().from(locales).orderBy(locales.isDefault, locales.name)
    return rows.map(parseLocale)
  })

  // Get single locale by code
  app.get<{ Params: { code: string } }>('/:code', async (req, reply) => {
    const row = (await db.select().from(locales).where(eq(locales.code, req.params.code)))[0]
    if (!row) return reply.code(404).send({ error: 'Locale not found' })
    return parseLocale(row)
  })

  // Create new locale
  app.post<{ Body: { code: string; name: string } }>('/', async (req, reply) => {
    const { code, name } = req.body
    if (!code || !/^[a-z]{2,10}(-[a-z]{2,4})?$/.test(code)) {
      return reply.code(400).send({ error: 'Invalid locale code. Use format: en, pl, de, pt-br' })
    }
    if (!name?.trim()) {
      return reply.code(400).send({ error: 'Name is required' })
    }
    const existing = (await db.select().from(locales).where(eq(locales.code, code)))[0]
    if (existing) return reply.code(409).send({ error: 'Locale already exists' })

    const row = await db.insert(locales).values({
      code,
      name: name.trim(),
      isDefault: 0,
      translations: '{}',
      updatedAt: Date.now(),
    }).returning()
    return parseLocale(row[0]!)
  })

  // Update locale name or public status-page translations.
  app.patch<{ Params: { code: string }; Body: { name?: string; translations?: Record<string, string> } }>(
    '/:code', async (req, reply) => {
      const row = (await db.select().from(locales).where(eq(locales.code, req.params.code)))[0]
      if (!row) return reply.code(404).send({ error: 'Locale not found' })

      const updates: Partial<typeof locales.$inferInsert> = { updatedAt: Date.now() }
      if (req.body.name?.trim()) updates.name = req.body.name.trim()
      if (req.body.translations !== undefined) updates.translations = JSON.stringify(req.body.translations)

      const updated = await db.update(locales).set(updates).where(eq(locales.code, req.params.code)).returning()
      return parseLocale(updated[0]!)
    },
  )

  // Set locale as default (clears isDefault on all others)
  app.post<{ Params: { code: string } }>('/:code/set-default', async (req, reply) => {
    const row = (await db.select().from(locales).where(eq(locales.code, req.params.code)))[0]
    if (!row) return reply.code(404).send({ error: 'Locale not found' })

    await db.update(locales).set({ isDefault: 0 })
    await db.update(locales).set({ isDefault: 1 }).where(eq(locales.code, req.params.code))
    return parseLocale((await db.select().from(locales).where(eq(locales.code, req.params.code)))[0]!)
  })

  // Delete locale (cannot delete default)
  app.delete<{ Params: { code: string } }>('/:code', async (req, reply) => {
    const row = (await db.select().from(locales).where(eq(locales.code, req.params.code)))[0]
    if (!row) return reply.code(404).send({ error: 'Locale not found' })
    if (row.isDefault) return reply.code(400).send({ error: 'Cannot delete the default locale' })

    await db.delete(locales).where(eq(locales.code, req.params.code))
    return reply.code(204).send()
  })
}
