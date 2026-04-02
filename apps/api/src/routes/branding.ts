import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { branding } from '../db/schema.js'
import path from 'path'
import fs from 'fs'
import { pipeline } from 'stream/promises'

const UPLOAD_DIR = process.env['UPLOAD_DIR'] ?? './data/uploads'

export async function brandingRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    const row = (await db.select().from(branding))[0]
    if (!row) {
      return {
        id: 1, siteName: 'Status Page', logoUrl: null, faviconUrl: null,
        primaryColor: '#6366f1', accentColor: '#f59e0b', customCss: null, updatedAt: Date.now(),
      }
    }
    return row
  })

  app.patch<{ Body: Partial<{ siteName: string; primaryColor: string; accentColor: string; customCss: string | null }> }>(
    '/', async (req) => {
      const now = Date.now()
      const existing = (await db.select().from(branding))[0]
      const updates: Record<string, unknown> = { updatedAt: now }
      if (req.body.siteName !== undefined) updates['siteName'] = req.body.siteName
      if (req.body.primaryColor !== undefined) updates['primaryColor'] = req.body.primaryColor
      if (req.body.accentColor !== undefined) updates['accentColor'] = req.body.accentColor
      if (req.body.customCss !== undefined) updates['customCss'] = req.body.customCss

      if (existing) {
        const results = await db.update(branding).set(updates).returning()
        return results[0]
      } else {
        const results = await db.insert(branding).values({
          id: 1,
          siteName: (updates['siteName'] as string | undefined) ?? 'Status Page',
          primaryColor: (updates['primaryColor'] as string | undefined) ?? '#6366f1',
          accentColor: (updates['accentColor'] as string | undefined) ?? '#f59e0b',
          customCss: updates['customCss'] as string | null | undefined,
          updatedAt: updates['updatedAt'] as number,
        }).returning()
        return results[0]
      }
    },
  )

  app.post('/logo', async (req, reply) => {
    const data = await req.file()
    if (!data) return reply.code(400).send({ error: 'No file' })

    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    }

    const ext = path.extname(data.filename) || '.png'
    const filename = `logo${ext}`
    const filepath = path.join(UPLOAD_DIR, filename)
    await pipeline(data.file, fs.createWriteStream(filepath))

    const logoUrl = `/uploads/${filename}`
    const existing = (await db.select().from(branding))[0]
    if (existing) {
      await db.update(branding).set({ logoUrl, updatedAt: Date.now() })
    } else {
      await db.insert(branding).values({
        id: 1, siteName: 'Status Page', primaryColor: '#6366f1', accentColor: '#f59e0b', logoUrl, updatedAt: Date.now(),
      })
    }
    return { url: logoUrl }
  })
}
