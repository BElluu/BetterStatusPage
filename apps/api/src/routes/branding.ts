import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { branding } from '../db/schema.js'
import path from 'path'
import fs from 'fs'
import { pipeline } from 'stream/promises'

const UPLOAD_DIR = process.env['UPLOAD_DIR'] ?? './data/uploads'

const DEFAULTS = {
  siteName: 'Status Page',
  logoUrl: null as string | null,
  faviconUrl: null as string | null,
  primaryColor: '#6366f1',
  accentColor: '#f59e0b',
  backgroundColor: '#0f172a',
  cardBackground: '#0f172a',
  cardBorderColor: '#1e293b',
  textColor: '#f8fafc',
  textMutedColor: '#94a3b8',
  statusUpColor: '#10b981',
  statusDownColor: '#ef4444',
  statusDegradedColor: '#f59e0b',
  customCss: null as string | null,
}

type BrandingBody = Partial<Omit<typeof DEFAULTS, 'logoUrl' | 'faviconUrl'>>

export async function brandingRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    const row = (await db.select().from(branding))[0]
    if (!row) return { id: 1, ...DEFAULTS, updatedAt: Date.now() }
    return row
  })

  app.patch<{ Body: BrandingBody }>('/', async (req) => {
    const now = Date.now()
    const existing = (await db.select().from(branding))[0]
    const updates: Record<string, unknown> = { updatedAt: now }

    const fields = [
      'siteName', 'primaryColor', 'accentColor', 'backgroundColor',
      'cardBackground', 'cardBorderColor', 'textColor', 'textMutedColor',
      'statusUpColor', 'statusDownColor', 'statusDegradedColor', 'customCss',
    ] as const
    for (const field of fields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field]
    }

    if (existing) {
      const results = await db.update(branding).set(updates).returning()
      return results[0]
    } else {
      const results = await db.insert(branding).values({
        id: 1,
        ...DEFAULTS,
        ...(updates as Partial<typeof DEFAULTS>),
        updatedAt: now,
      }).returning()
      return results[0]
    }
  })

  app.post('/logo', async (req, reply) => {
    const data = await req.file()
    if (!data) return reply.code(400).send({ error: 'No file' })

    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

    const ext = path.extname(data.filename) || '.png'
    const filename = `logo${ext}`
    await pipeline(data.file, fs.createWriteStream(path.join(UPLOAD_DIR, filename)))

    const logoUrl = `/uploads/${filename}`
    const existing = (await db.select().from(branding))[0]
    if (existing) {
      await db.update(branding).set({ logoUrl, updatedAt: Date.now() })
    } else {
      await db.insert(branding).values({ id: 1, ...DEFAULTS, logoUrl, updatedAt: Date.now() })
    }
    return { url: logoUrl }
  })
}
