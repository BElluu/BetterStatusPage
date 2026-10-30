import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MirrorObject } from '@better-forge/mirror'
import type { ChartNode, LayoutNode, LayoutTree, StatusSnapshot } from '@bsp/shared'
import { uploadDir } from '../config.js'
import {
  loadHistory, loadPublicIncidents, loadPublicLayout, loadPublicLocale, loadPublicLocales, loadPublicStatus, loadUptime,
} from './publicStatusData.js'

/** The newest incidents the page lists; the Incidents block of the builder allows at most this many. */
const SNAPSHOT_INCIDENTS = 20
const UPTIME_DAYS = 90
const SNAPSHOT_KEY = 'snapshot.json'
const SNAPSHOT_META = `<meta name="bsp-snapshot" content="/${SNAPSHOT_KEY}" />`

const here = path.dirname(fileURLToPath(import.meta.url))
/** `apps/status/dist`, from `src/services` as well as from `dist/services`. */
export const defaultStatusDist = path.resolve(here, '../../../status/dist')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

const contentType = (file: string): string => CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'

function chartNodes(nodes: LayoutNode[], into: ChartNode[] = []): ChartNode[] {
  for (const node of nodes) {
    if (node.type === 'chart') into.push(node)
    else if (node.type === 'group') chartNodes(node.children, into)
  }
  return into
}

export async function buildSnapshot(now = Date.now(), options: { intervalSeconds?: number; showBanner?: boolean } = {}): Promise<StatusSnapshot> {
  const [status, layout, incidents, locales] = await Promise.all([
    loadPublicStatus(), loadPublicLayout(), loadPublicIncidents({ limit: SNAPSHOT_INCIDENTS, offset: 0 }), loadPublicLocales(),
  ])
  const uptime: StatusSnapshot['uptime'] = {}
  for (const monitor of status.monitors) {
    const { days, overallUptimePct } = await loadUptime(monitor.id, UPTIME_DAYS)
    uptime[String(monitor.id)] = { days, overallUptimePct }
  }
  // A chart asks for its own range; the copy can only answer the ranges the layout has charts for.
  const history: NonNullable<StatusSnapshot['history']> = {}
  const published = new Set(status.monitors.map((monitor) => monitor.id))
  for (const chart of chartNodes((layout.tree as LayoutTree).children)) {
    const key = `${chart.monitorId}:${chart.hours}:${chart.buckets}`
    if (published.has(chart.monitorId) && !history[key]) history[key] = await loadHistory(chart.monitorId, chart.hours, chart.buckets)
  }
  const translations: StatusSnapshot['translations'] = {}
  for (const { code } of locales) translations[code] = (await loadPublicLocale(code))?.translations ?? {}
  return { schemaVersion: 1, generatedAt: now, ...(options.intervalSeconds ? { intervalSeconds: options.intervalSeconds } : {}), ...(options.showBanner === false ? { showBanner: false } : {}), status, layout, incidents, uptime, history, locales, translations }
}

/** Every file below a directory, as paths relative to it with `/` separators. */
function listFiles(root: string, dir = root): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? listFiles(root, full) : [path.relative(root, full).split(path.sep).join('/')]
  })
}

/** The uploaded images the snapshot refers to (logos, favicon), read from the upload folder only. */
function uploadsOf(snapshot: StatusSnapshot): MirrorObject[] {
  const brandings = [
    (snapshot.status as { branding?: Record<string, unknown> | null }).branding,
    (snapshot.layout as { branding?: Record<string, unknown> | null }).branding,
  ]
  const urls = new Set<string>()
  for (const branding of brandings) {
    for (const field of ['logoUrl', 'faviconUrl', 'logoLightUrl', 'logoDarkUrl']) {
      const value = branding?.[field]
      if (typeof value === 'string' && value.startsWith('/uploads/')) urls.add(value)
    }
  }
  let realRoot: string
  try { realRoot = fs.realpathSync(uploadDir()) } catch { return [] }
  const objects: MirrorObject[] = []
  for (const url of urls) {
    // A stored URL is data: whatever it says, nothing outside the upload folder is read or named.
    let file: string
    try {
      file = fs.realpathSync(path.resolve(realRoot, decodeURIComponent(url.slice('/uploads/'.length))))
    } catch { continue }
    if (!file.startsWith(realRoot + path.sep)) continue
    const key = 'uploads/' + path.relative(realRoot, file).split(path.sep).join('/')
    objects.push({ key, body: fs.readFileSync(file), contentType: contentType(file), cacheControl: 'public, max-age=3600' })
  }
  return objects
}

/**
 * What to put on the static host, in the order to upload it: the files of the status page (the page itself last, as
 * it names the others), the images the snapshot refers to, and the snapshot, which changes every time.
 */
export function buildMirrorObjects(snapshot: StatusSnapshot, statusDist = defaultStatusDist): MirrorObject[] {
  const indexFile = path.join(statusDist, 'index.html')
  if (!fs.existsSync(indexFile)) throw new Error('The status page is not built: apps/status/dist/index.html is missing')
  const html = fs.readFileSync(indexFile, 'utf8')
  if (!html.includes('</head>')) throw new Error('index.html of the status page has no <head> to mark as a saved copy')
  const savedCopy = html.replace('</head>', `    ${SNAPSHOT_META}\n  </head>`)

  const files = listFiles(statusDist).filter((file) => file !== 'index.html')
  const assets: MirrorObject[] = files.map((file) => ({
    key: file,
    body: fs.readFileSync(path.join(statusDist, file)),
    contentType: contentType(file),
    // Hashed names never change their content; the logos and icon under fixed names may.
    cacheControl: file.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
  }))
  const page = { contentType: contentType('index.html'), cacheControl: 'no-cache' }
  return [
    ...assets,
    ...uploadsOf(snapshot),
    { key: 'index.html', body: savedCopy, ...page },
    // Hosts serve it for unknown paths, as the live instance serves the page for them.
    { key: '404.html', body: savedCopy, ...page },
    { key: SNAPSHOT_KEY, body: JSON.stringify(snapshot), contentType: 'application/json', cacheControl: 'no-cache' },
  ]
}
