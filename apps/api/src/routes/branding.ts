import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/client.js'
import { branding } from '../db/schema.js'
import path from 'path'
import fs from 'fs'
import { uploadDir } from '../config.js'
import { diffObjects, writeAudit } from '../services/audit.js'
import { DEFAULT_BRANDING_COLORS } from '@bsp/shared'

const ALLOWED_MIME_MAGIC: Array<{ mime: string; magic: number[] }> = [
  { mime: 'image/jpeg', magic: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png',  magic: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/gif',  magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] }, // RIFF (verified further below)
]

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/gif':  '.gif',
  'image/webp': '.webp',
}

const MANAGED_LOGO_BASENAMES = ['logo', 'logo-light', 'logo-dark'] as const

function cleanupUnusedManagedLogoFiles(row: typeof branding.$inferSelect): void {
  const referencedUrls = new Set([row.logoUrl, row.logoLightUrl, row.logoDarkUrl].filter((url): url is string => !!url))
  const uploads = uploadDir()
  for (const basename of MANAGED_LOGO_BASENAMES) {
    for (const ext of Object.values(MIME_TO_EXT)) {
      const url = `/uploads/${basename}${ext}`
      if (!referencedUrls.has(url)) fs.rmSync(path.join(uploads, `${basename}${ext}`), { force: true })
    }
  }
}

export function detectImageMime(buf: Buffer): string | null {
  for (const { mime, magic } of ALLOWED_MIME_MAGIC) {
    if (magic.every((byte, i) => buf[i] === byte)) {
      if (mime === 'image/webp') {
        // RIFF....WEBP — bytes 8-11 must be 0x57 0x45 0x42 0x50
        if (buf.length < 12) return null
        if (buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return mime
        return null
      }
      return mime
    }
  }
  return null
}

const DEFAULTS = {
  siteName: 'Status Page',
  logoUrl: null as string | null,
  logoLightUrl: null as string | null,
  logoDarkUrl: null as string | null,
  faviconUrl: null as string | null,
  ...DEFAULT_BRANDING_COLORS,
  customCss: null as string | null,
  enabled: 0 as number,
  logoType: 'image' as string,
  logoText: null as string | null,
}

type BrandingBody = Partial<Omit<typeof DEFAULTS, 'faviconUrl'>>

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
      'statusUpColor', 'statusDownColor', 'statusDegradedColor', 'customCss', 'enabled',
      'elevatedBackground', 'chartBackground', 'chartGridColor',
      'logoType', 'logoText', 'logoUrl', 'logoLightUrl', 'logoDarkUrl',
    ] as const
    for (const field of fields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field]
    }

    const row = existing
      ? (await db.update(branding).set(updates).returning())[0]!
      : (await db.insert(branding).values({
        id: 1,
        ...DEFAULTS,
        ...(updates as Partial<typeof DEFAULTS>),
        updatedAt: now,
      }).returning())[0]!
    cleanupUnusedManagedLogoFiles(row)
    const actor = req.user as { userId: number; email: string }
    const changedFields = Object.keys(updates).filter((field) => field !== 'updatedAt')
    const before = Object.fromEntries(changedFields.map((field) => [field, existing?.[field as keyof typeof existing] ?? null]))
    const after = Object.fromEntries(changedFields.map((field) => [field, row[field as keyof typeof row]]))
    await writeAudit(
      { userId: actor.userId, userEmail: actor.email },
      existing ? 'update' : 'create',
      'branding',
      1,
      row.siteName,
      diffObjects(before, after),
    )
    return row
  })

  async function uploadLogo(req: FastifyRequest, reply: FastifyReply, field: 'logoUrl' | 'logoLightUrl' | 'logoDarkUrl', basename: string) {
    const data = await req.file()
    if (!data) return reply.code(400).send({ error: 'No file' })

    const chunks: Buffer[] = []
    for await (const chunk of data.file) chunks.push(chunk as Buffer)
    const buf = Buffer.concat(chunks)

    const mime = detectImageMime(buf)
    if (!mime) return reply.code(400).send({ error: 'Invalid image. Allowed types: JPEG, PNG, GIF, WebP' })

    const uploads = uploadDir()
    if (!fs.existsSync(uploads)) fs.mkdirSync(uploads, { recursive: true })

    const ext = MIME_TO_EXT[mime]!
    const filename = `${basename}${ext}`
    fs.writeFileSync(path.join(uploads, filename), buf)

    const logoUrl = `/uploads/${filename}`
    const existing = (await db.select().from(branding))[0]
    const row = existing
      ? (await db.update(branding).set({ [field]: logoUrl, updatedAt: Date.now() }).returning())[0]!
      : (await db.insert(branding).values({ id: 1, ...DEFAULTS, [field]: logoUrl, updatedAt: Date.now() }).returning())[0]!
    cleanupUnusedManagedLogoFiles(row)
    const actor = req.user as { userId: number; email: string }
    await writeAudit(
      { userId: actor.userId, userEmail: actor.email },
      existing ? 'update' : 'create',
      'branding',
      1,
      existing?.siteName ?? DEFAULTS.siteName,
      { [field]: { from: existing?.[field] ?? null, to: logoUrl } },
    )
    return { url: logoUrl }
  }

  app.post('/logo', async (req, reply) => uploadLogo(req, reply, 'logoUrl', 'logo'))
  app.post('/logo/light', async (req, reply) => uploadLogo(req, reply, 'logoLightUrl', 'logo-light'))
  app.post('/logo/dark', async (req, reply) => uploadLogo(req, reply, 'logoDarkUrl', 'logo-dark'))
}
