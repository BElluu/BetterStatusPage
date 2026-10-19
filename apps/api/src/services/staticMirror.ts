import { desc, eq, notInArray } from 'drizzle-orm'
import { createIntervalRunner, createMirrorPublisher, createS3Transport } from '@better-kit/mirror'
import type {
  AdminStaticMirror, StaticMirrorCheckResult, StaticMirrorHealthState, StaticMirrorRun, StaticMirrorSettings, StaticMirrorStatus,
} from '@bsp/shared'
import { db } from '../db/client.js'
import { staticMirrorRuns, staticMirrorSettings, staticMirrorStatus } from '../db/schema.js'
import { decrypt, encrypt } from '../kit/secretBox.js'
import { SECRET_MASK } from './secretFields.js'
import { isStatusPagePrivate } from './statusPageAccess.js'
import { buildMirrorObjects, buildSnapshot } from './staticSnapshot.js'

export class StaticMirrorError extends Error {}

const MIN_INTERVAL_SECONDS = 60
const MAX_INTERVAL_SECONDS = 86_400
/** A mirror whose last success is older than this many intervals is reported as stale. */
const STALE_AFTER_INTERVALS = 3
const MAX_ERROR_LENGTH = 300
const ACCESS_CHECK_KEY = '.bsp-access-check'

const DEFAULTS: StaticMirrorSettings = {
  enabled: false, endpoint: '', region: 'auto', bucket: '', accessKeyId: '', secretAccessKey: '',
  intervalSeconds: MIN_INTERVAL_SECONDS, showBanner: true,
}

async function readRow() {
  return (await db.select().from(staticMirrorSettings).where(eq(staticMirrorSettings.id, 1)))[0] ?? null
}

function toSettings(row: Awaited<ReturnType<typeof readRow>>): StaticMirrorSettings {
  if (!row) return { ...DEFAULTS }
  return {
    enabled: !!row.enabled,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    accessKeyId: row.accessKeyId,
    secretAccessKey: row.secretAccessKey ? SECRET_MASK : '',
    intervalSeconds: row.intervalSeconds,
    showBanner: !!row.showBanner,
  }
}

export async function getStaticMirrorSettings(): Promise<StaticMirrorSettings> {
  return toSettings(await readRow())
}

/** The stored (encrypted) secret, to tell whether a save replaced it; never sent anywhere. */
export async function storedMirrorSecret(): Promise<string> {
  return (await readRow())?.secretAccessKey ?? ''
}

export async function getStaticMirrorStatus(): Promise<StaticMirrorStatus> {
  const row = (await db.select().from(staticMirrorStatus).where(eq(staticMirrorStatus.id, 1)))[0]
  return {
    lastRunAt: row?.lastRunAt ?? null,
    lastSuccessAt: row?.lastSuccessAt ?? null,
    lastError: row?.lastError ?? null,
    lastUploadedFiles: row?.lastUploadedFiles ?? 0,
    copyFiles: row?.copyFiles ?? null,
    copyBytes: row?.copyBytes ?? null,
  }
}

export function mirrorHealth(settings: StaticMirrorSettings, status: StaticMirrorStatus, now = Date.now()): StaticMirrorHealthState {
  if (!settings.enabled) return 'disabled'
  if (status.lastError) return 'error'
  if (status.lastSuccessAt === null) return 'pending'
  if (now - status.lastSuccessAt > STALE_AFTER_INTERVALS * settings.intervalSeconds * 1000) return 'stale'
  return 'ok'
}

/** The latest pushes, oldest first. */
async function listRuns(limit = 24): Promise<StaticMirrorRun[]> {
  const rows = await db.select().from(staticMirrorRuns).orderBy(desc(staticMirrorRuns.id)).limit(limit)
  return rows.reverse().map((row) => ({ at: row.ranAt, ok: !!row.ok, uploadedFiles: row.uploadedFiles, error: row.error }))
}

export async function getAdminStaticMirror(): Promise<AdminStaticMirror> {
  const [settings, status, runs] = await Promise.all([getStaticMirrorSettings(), getStaticMirrorStatus(), listRuns()])
  return { settings, status, health: mirrorHealth(settings, status), runs }
}

function httpUrl(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
  if (!text) return ''
  let url: URL
  try { url = new URL(text) } catch { throw new StaticMirrorError(`${label} must be a full URL, such as https://example.com`) }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new StaticMirrorError(`${label} must start with http:// or https://`)
  // A URL with credentials would put them in every log line and error message.
  if (url.username || url.password || url.search || url.hash) throw new StaticMirrorError(`${label} must not contain credentials, a query or a fragment`)
  return text
}

/** AWS S3 needs a real region and a lowercase bucket name; "auto" is for services that take an endpoint. */
function assertAwsSettings(endpoint: string, region: string, bucket: string): void {
  if (!endpoint && (region === 'auto' || bucket !== bucket.toLowerCase())) {
    throw new StaticMirrorError('Without an endpoint (AWS S3) the region must be a real one, such as eu-central-1, and the bucket name lowercase')
  }
}

/** A failure as the page shows it. A network failure is only "fetch failed"; its cause names the reason (ECONNREFUSED, a certificate code, ...). */
function describeError(error: unknown): string {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined
  const text = error instanceof Error ? error.message : String(error)
  return (typeof cause === 'string' ? `${text} (${cause})` : text).slice(0, MAX_ERROR_LENGTH)
}

/** Throws a {@link StaticMirrorError} naming the first thing wrong; returns the row to store. */
async function validate(input: Partial<Record<keyof StaticMirrorSettings, unknown>>, stored: Awaited<ReturnType<typeof readRow>>) {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const enabled = input.enabled === true
  const interval = Number(input.intervalSeconds ?? MIN_INTERVAL_SECONDS)
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_SECONDS || interval > MAX_INTERVAL_SECONDS) {
    throw new StaticMirrorError(`The interval must be between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} seconds`)
  }
  const bucket = text(input.bucket)
  const region = text(input.region) || 'auto'
  const accessKeyId = text(input.accessKeyId)
  if (bucket && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,62}$/.test(bucket)) throw new StaticMirrorError('The bucket name is not valid')
  if (!/^[A-Za-z0-9-]{1,40}$/.test(region)) throw new StaticMirrorError('The region is not valid')
  if (/\s/.test(accessKeyId) || accessKeyId.length > 256) throw new StaticMirrorError('The access key ID is not valid')

  // The mask (or nothing) keeps the stored secret; an empty string clears it.
  const sent = input.secretAccessKey
  const secretAccessKey = sent === undefined || sent === SECRET_MASK
    ? stored?.secretAccessKey ?? ''
    : typeof sent === 'string' && sent.trim() ? encrypt(sent.trim()) : ''

  if (enabled) {
    if (!bucket || !accessKeyId || !secretAccessKey) throw new StaticMirrorError('Bucket, access key ID and secret access key are required to turn the mirror on')
    assertAwsSettings(text(input.endpoint), region, bucket)
    // The copy is on the open internet; a private page must never be put there.
    if (await isStatusPagePrivate()) throw new StaticMirrorError('The status page is private, so it cannot be mirrored to public hosting')
  }
  return {
    enabled: enabled ? 1 : 0,
    endpoint: httpUrl(input.endpoint, 'The endpoint'),
    region, bucket, accessKeyId, secretAccessKey,
    intervalSeconds: interval,
    // Shown unless the client says otherwise, as before the setting existed.
    showBanner: input.showBanner === false ? 0 : 1,
    updatedAt: Date.now(),
  }
}

export async function saveStaticMirrorSettings(input: Partial<Record<keyof StaticMirrorSettings, unknown>>): Promise<StaticMirrorSettings> {
  const row = await validate(input, await readRow())
  await db.insert(staticMirrorSettings).values({ id: 1, ...row }).onConflictDoUpdate({ target: staticMirrorSettings.id, set: row })
  await applyStaticMirror()
  return getStaticMirrorSettings()
}

async function recordStatus(patch: Partial<typeof staticMirrorStatus.$inferInsert>) {
  await db.insert(staticMirrorStatus).values({ id: 1, ...patch }).onConflictDoUpdate({ target: staticMirrorStatus.id, set: patch })
}

/** The page shows the latest 24; a day of failures at one push a minute must not grow the table. */
const KEPT_RUNS = 48

async function recordRun(run: { ranAt: number; ok: boolean; uploadedFiles: number; error: string | null }) {
  await db.insert(staticMirrorRuns).values({ ranAt: run.ranAt, ok: run.ok ? 1 : 0, uploadedFiles: run.uploadedFiles, error: run.error })
  const newest = db.select({ id: staticMirrorRuns.id }).from(staticMirrorRuns).orderBy(desc(staticMirrorRuns.id)).limit(KEPT_RUNS)
  await db.delete(staticMirrorRuns).where(notInArray(staticMirrorRuns.id, newest))
}

/**
 * What has been uploaded is remembered per target, so a changed bucket or key starts with a full upload. The memory is
 * dropped when the settings are saved, on Push now, and every few hours: a bucket that was emptied, or lost files to a
 * lifecycle rule, gets its page back instead of only the snapshot.
 */
let publisher: { fingerprint: string; createdAt: number; value: ReturnType<typeof createMirrorPublisher> } | null = null
const FULL_UPLOAD_EVERY_MS = 6 * 60 * 60_000
let inFlight: Promise<void> | null = null

async function mirrorOnce(): Promise<void> {
  const startedAt = Date.now()
  try {
    if (await isStatusPagePrivate()) throw new Error('The status page is private, so it is not mirrored')
    const row = await readRow()
    if (!row) throw new Error('The mirror is not configured')
    const fingerprint = JSON.stringify([row.endpoint, row.region, row.bucket, row.accessKeyId, row.secretAccessKey])
    if (publisher && Date.now() - publisher.createdAt > FULL_UPLOAD_EVERY_MS) publisher = null
    if (publisher?.fingerprint !== fingerprint) {
      publisher = {
        fingerprint,
        createdAt: Date.now(),
        value: createMirrorPublisher({
          transport: createS3Transport({
            bucket: row.bucket, region: row.region, accessKeyId: row.accessKeyId, secretAccessKey: decrypt(row.secretAccessKey),
            ...(row.endpoint ? { endpoint: row.endpoint } : {}),
          }),
        }),
      }
    }
    const objects = buildMirrorObjects(await buildSnapshot(startedAt, { intervalSeconds: row.intervalSeconds, showBanner: !!row.showBanner }))
    // Building takes a while; the page may have been made private meanwhile.
    if (await isStatusPagePrivate()) throw new Error('The status page is private, so it is not mirrored')
    const { uploaded } = await publisher.value.publish(objects)
    const copyBytes = objects.reduce((sum, object) => sum + (typeof object.body === 'string' ? Buffer.byteLength(object.body) : object.body.length), 0)
    await recordStatus({ lastRunAt: startedAt, lastSuccessAt: Date.now(), lastError: null, lastUploadedFiles: uploaded.length, copyFiles: objects.length, copyBytes })
    await recordRun({ ranAt: startedAt, ok: true, uploadedFiles: uploaded.length, error: null }).catch(() => { /* the history is a nicety */ })
  } catch (error) {
    const message = describeError(error)
    await recordStatus({ lastRunAt: startedAt, lastError: message }).catch(() => { /* nothing more to report it to */ })
    await recordRun({ ranAt: startedAt, ok: false, uploadedFiles: 0, error: message }).catch(() => { /* the history is a nicety */ })
  }
}

/**
 * One mirror run, or the one already going. The settings are not consulted: the caller decides whether to run.
 * `full` uploads everything again instead of only what changed.
 */
export function runStaticMirror({ full = false }: { full?: boolean } = {}): Promise<void> {
  if (!inFlight) {
    if (full) publisher = null
    inFlight = mirrorOnce().finally(() => { inFlight = null })
  }
  return inFlight
}

let intervalSeconds = MIN_INTERVAL_SECONDS
const runner = createIntervalRunner({ intervalMs: () => intervalSeconds * 1000, job: runStaticMirror })

let applying: Promise<void> = Promise.resolve()

/**
 * Starts or stops the schedule to match the saved settings. Applies run one after another, each reading the settings
 * when its turn comes, so the last save wins however the requests interleave.
 */
export function applyStaticMirror(): Promise<void> {
  // A rejected apply must not leave every later one skipped.
  applying = applying.catch(() => { /* reported to the caller of that apply */ }).then(async () => {
    const settings = await getStaticMirrorSettings()
    intervalSeconds = settings.intervalSeconds
    publisher = null
    // A save does not wait for a push that is in progress; that one ends on its own.
    await runner.stop({ wait: false })
    if (settings.enabled) runner.start()
  })
  return applying
}

export function startStaticMirror(): void {
  void applyStaticMirror().catch(() => { /* the database was not ready; the next save applies the settings again */ })
}

export function stopStaticMirror(): void {
  void runner.stop()
}

/**
 * Tries a key against a bucket without pushing the page: writes a tiny object and removes it again. The settings are
 * the ones in the form, saved or not; the mask stands for the stored secret.
 */
export async function checkStaticMirrorAccess(input: Partial<Record<keyof StaticMirrorSettings, unknown>>): Promise<StaticMirrorCheckResult> {
  // Validated as a draft: whether it may be switched on is not what is asked here.
  const row = await validate({ ...input, enabled: false }, await readRow())
  if (!row.bucket || !row.accessKeyId || !row.secretAccessKey) {
    throw new StaticMirrorError('Fill in the bucket, the access key ID and the secret access key first')
  }
  assertAwsSettings(row.endpoint, row.region, row.bucket)
  const transport = createS3Transport({
    bucket: row.bucket, region: row.region, accessKeyId: row.accessKeyId, secretAccessKey: decrypt(row.secretAccessKey),
    ...(row.endpoint ? { endpoint: row.endpoint } : {}),
  })
  // One name, so a key that cannot delete leaves a single tiny file that the next check overwrites.
  const key = ACCESS_CHECK_KEY
  try {
    await transport.put({ key, body: 'ok', contentType: 'text/plain' }, AbortSignal.timeout(15_000))
    // A pushing key needs no right to delete; the check passed when the write did, and a leftover is harmless.
    await transport.delete(key, AbortSignal.timeout(15_000)).catch(() => { /* see above */ })
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}
