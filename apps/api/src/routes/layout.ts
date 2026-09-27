import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { layout } from '../db/schema.js'
import { auditActor, writeAudit } from '../services/audit.js'
import { requestIdentity } from '../middleware/auth.js'
import { refreshPublishedMonitorIds } from '../services/publishedMonitors.js'

export async function layoutRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    const row = (await db.select().from(layout))[0]
    if (!row) return { id: 'root', type: 'page', children: [] }
    return JSON.parse(row.tree)
  })

  app.put<{ Body: { tree: unknown } }>('/', async (req) => {
    const now = Date.now()
    const existing = (await db.select().from(layout))[0]
    if (existing) {
      await db.update(layout).set({ tree: JSON.stringify(req.body.tree), updatedAt: now })
    } else {
      await db.insert(layout).values({ id: 1, tree: JSON.stringify(req.body.tree), updatedAt: now })
    }
    await refreshPublishedMonitorIds()
    const actor = requestIdentity(req)
    await writeAudit(
      auditActor(actor),
      existing ? 'update' : 'create',
      'layout',
      1,
      'Status page layout',
      { tree: { from: existing ? '[previous layout]' : null, to: '[updated layout]' } },
    )
    return req.body.tree
  })
}
