import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { auditLog } from '../db/schema.js'
import { desc, eq, like, gte, lte, and, sql } from 'drizzle-orm'

export async function auditRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      page?: string
      limit?: string
      userEmail?: string
      entityType?: string
      action?: string
      from?: string   // unix ms
      to?: string     // unix ms
    }
  }>('/', async (req) => {
    const page   = Math.max(1, Number(req.query.page  ?? 1))
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)))
    const offset = (page - 1) * limit

    const conditions = []
    if (req.query.userEmail) conditions.push(like(auditLog.userEmail, `%${req.query.userEmail}%`))
    if (req.query.entityType) conditions.push(eq(auditLog.entityType, req.query.entityType))
    if (req.query.action)     conditions.push(eq(auditLog.action, req.query.action))
    if (req.query.from)       conditions.push(gte(auditLog.timestamp, Number(req.query.from)))
    if (req.query.to)         conditions.push(lte(auditLog.timestamp, Number(req.query.to)))

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const [entries, countResult] = await Promise.all([
      db.select().from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.timestamp))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(auditLog).where(where),
    ])

    const total = countResult[0]?.count ?? 0
    return {
      entries: entries.map((e) => ({ ...e, diff: e.diff ? JSON.parse(e.diff) : null })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    }
  })
}
