import { randomBytes } from 'node:crypto'
import { DATABASE_TLS_MODES, isDatabaseType } from '@bsp/shared'
import type { AutoIncidentMode, DatabaseTlsMode, MonitorTag, MonitorType } from '@bsp/shared'
import { validateHttpAssertions } from '../workers/assertions.js'
import { validateDockerConfig } from '../workers/docker.js'

export const MONITOR_TYPES: readonly MonitorType[] = ['https', 'ping', 'dns', 'sqlserver', 'postgresql', 'mysql', 'mongodb', 'docker', 'webhook']

export const INTERVAL_SECS_RANGE = [10, 86_400] as const
export const TIMEOUT_MS_RANGE = [1_000, 300_000] as const
export const RETRIES_RANGE = [1, 10] as const
export const THRESHOLD_RANGE = [1, 20] as const
/** Minutes a confirmed outage may last before an incident opens: 1 minute to 7 days. */
export const AUTO_INCIDENT_MINUTES_RANGE = [1, 10_080] as const
const AUTO_INCIDENT_MODES: readonly AutoIncidentMode[] = ['draft', 'published']
const MAX_NAME_LENGTH = 200
const MAX_TAGS = 20

/** What a heartbeat token looks like: the heartbeat route and the configuration import both accept exactly this. */
export const WEBHOOK_TOKEN_PATTERN = /^[0-9a-f]{48}$/

/** The secret part of a webhook monitor's heartbeat URL. */
export function generateWebhookToken(): string {
  return randomBytes(24).toString('hex')
}

const configField = (config: unknown, key: string): unknown => (config && typeof config === 'object' ? (config as Record<string, unknown>)[key] : undefined)
const configUrl = (config: unknown): unknown => configField(config, 'url')
const ignoresTls = (config: unknown): boolean => configField(config, 'ignoreTls') === true

/**
 * What a changed monitor configuration resets: the certificate is read again on the next check, so a changed
 * warning setting takes effect right away, and a different endpoint, or a change of whether the certificate is
 * verified, also forgets what was known about the old certificate.
 */
export function certResetsFor(previousConfig: unknown, nextConfig: unknown):
  { certCheckedAt: null; certExpiresAt?: null; certWarnedDays?: null } {
  return configUrl(previousConfig) === configUrl(nextConfig) && ignoresTls(previousConfig) === ignoresTls(nextConfig)
    ? { certCheckedAt: null }
    : { certCheckedAt: null, certExpiresAt: null, certWarnedDays: null }
}

export interface MonitorFields {
  name: string
  type: MonitorType
  intervalSecs: number
  timeoutMs: number
  retries: number
  failureThreshold: number
  recoveryThreshold: number
  autoIncidentMinutes: number | null
  autoIncidentMode: AutoIncidentMode
  autoIncidentTemplateId: number | null
  config: Record<string, unknown>
  tags: MonitorTag[]
}

export type Parsed<T> = { value: T } | { error: string }

/** What a monitor needs from its current state to validate a partial update. */
export interface ExistingMonitor { type: string; failureThreshold: number; recoveryThreshold: number }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function rangeError(field: string, [min, max]: readonly [number, number]): string {
  return `${field} must be a whole number from ${min} to ${max}`
}

function inRange(value: unknown, [min, max]: readonly [number, number]): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/** Thresholds are "consecutive checks", so anything below 1 is meaningless; out-of-range values are clamped. */
function clampThreshold(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(THRESHOLD_RANGE[1], Math.max(THRESHOLD_RANGE[0], Math.round(value)))
}

/** The three auto-incident fields of a request; absent ones stay out so a partial update leaves them alone. */
function parseAutoIncident(input: Record<string, unknown>): Parsed<Partial<Pick<MonitorFields, 'autoIncidentMinutes' | 'autoIncidentMode' | 'autoIncidentTemplateId'>>> {
  const out: Partial<Pick<MonitorFields, 'autoIncidentMinutes' | 'autoIncidentMode' | 'autoIncidentTemplateId'>> = {}
  const minutes = input['autoIncidentMinutes']
  if (minutes !== undefined) {
    if (minutes !== null && !inRange(minutes, AUTO_INCIDENT_MINUTES_RANGE)) return { error: rangeError('autoIncidentMinutes', AUTO_INCIDENT_MINUTES_RANGE) + ' or null' }
    out.autoIncidentMinutes = minutes
  }
  const mode = input['autoIncidentMode']
  if (mode !== undefined) {
    if (!AUTO_INCIDENT_MODES.includes(mode as AutoIncidentMode)) return { error: `autoIncidentMode must be one of: ${AUTO_INCIDENT_MODES.join(', ')}` }
    out.autoIncidentMode = mode as AutoIncidentMode
  }
  const templateId = input['autoIncidentTemplateId']
  if (templateId !== undefined) {
    if (templateId !== null && !(Number.isInteger(templateId) && (templateId as number) > 0)) return { error: 'autoIncidentTemplateId must be a template id or null' }
    out.autoIncidentTemplateId = templateId as number | null
  }
  return { value: out }
}

function parseTags(value: unknown): Parsed<MonitorTag[]> {
  if (!Array.isArray(value) || value.length > MAX_TAGS
    || !value.every((tag) => isRecord(tag) && typeof tag['label'] === 'string' && typeof tag['color'] === 'string')) {
    return { error: `tags must be a list of up to ${MAX_TAGS} { label, color } objects` }
  }
  return { value: value.map((tag) => ({ label: tag.label as string, color: tag.color as string })) }
}

function parseType(value: unknown): Parsed<MonitorType> {
  return MONITOR_TYPES.includes(value as MonitorType)
    ? { value: value as MonitorType }
    : { error: `Type must be one of: ${MONITOR_TYPES.join(', ')}` }
}

function parseName(value: unknown): Parsed<string> {
  if (typeof value !== 'string' || !value.trim()) return { error: 'Name is required' }
  if (value.length > MAX_NAME_LENGTH) return { error: `Name must be at most ${MAX_NAME_LENGTH} characters` }
  return { value }
}

const MAX_TLS_CA_LENGTH = 64 * 1024

function validateDatabaseTls(config: Record<string, unknown>): string | null {
  const { tls, tlsCa } = config
  if (tls !== undefined && !DATABASE_TLS_MODES.includes(tls as DatabaseTlsMode)) return `tls must be one of: ${DATABASE_TLS_MODES.join(', ')}`
  if (tlsCa !== undefined && (typeof tlsCa !== 'string' || tlsCa.length > MAX_TLS_CA_LENGTH)) return `tlsCa must be PEM text of at most ${MAX_TLS_CA_LENGTH} characters`
  return null
}

function parseConfig(type: MonitorType, value: unknown): Parsed<Record<string, unknown>> {
  if (!isRecord(value)) return { error: 'config must be an object' }
  if (type === 'docker') {
    const invalid = validateDockerConfig(value)
    if (invalid) return { error: invalid }
  }
  if (isDatabaseType(type)) {
    const invalid = validateDatabaseTls(value)
    if (invalid) return { error: invalid }
  }
  if (type === 'https') {
    const invalid = validateHttpAssertions(value)
    if (invalid) return { error: invalid }
    if (value['ignoreTls'] !== undefined && typeof value['ignoreTls'] !== 'boolean') return { error: 'ignoreTls must be true or false' }
  }
  return { value }
}

/** Validates the body of a new monitor and fills in the defaults. */
export function parseNewMonitor(body: unknown): Parsed<MonitorFields> {
  const input = isRecord(body) ? body : {}
  const name = parseName(input['name'])
  if ('error' in name) return name
  const type = parseType(input['type'])
  if ('error' in type) return type

  const intervalSecs = input['intervalSecs'] ?? 60
  if (!inRange(intervalSecs, INTERVAL_SECS_RANGE)) return { error: rangeError('intervalSecs', INTERVAL_SECS_RANGE) }
  const timeoutMs = input['timeoutMs'] ?? 10_000
  if (!inRange(timeoutMs, TIMEOUT_MS_RANGE)) return { error: rangeError('timeoutMs', TIMEOUT_MS_RANGE) }
  const retries = input['retries'] ?? 1
  if (!inRange(retries, RETRIES_RANGE)) return { error: rangeError('retries', RETRIES_RANGE) }

  const config = parseConfig(type.value, input['config'] ?? {})
  if ('error' in config) return config
  const tags = parseTags(input['tags'] ?? [])
  if ('error' in tags) return tags
  const auto = parseAutoIncident(input)
  if ('error' in auto) return auto

  return {
    value: {
      name: name.value, type: type.value, intervalSecs, timeoutMs, retries,
      failureThreshold: clampThreshold(input['failureThreshold'], 1),
      recoveryThreshold: clampThreshold(input['recoveryThreshold'], 1),
      autoIncidentMinutes: auto.value.autoIncidentMinutes ?? null,
      autoIncidentMode: auto.value.autoIncidentMode ?? 'draft',
      autoIncidentTemplateId: auto.value.autoIncidentTemplateId ?? null,
      config: config.value, tags: tags.value,
    },
  }
}

/** Validates the fields present in a partial update; absent fields stay out of the result. */
export function parseMonitorPatch(body: unknown, existing: ExistingMonitor): Parsed<Partial<MonitorFields>> {
  const input = isRecord(body) ? body : {}
  const patch: Partial<MonitorFields> = {}

  if (input['name'] !== undefined) {
    const name = parseName(input['name'])
    if ('error' in name) return name
    patch.name = name.value
  }
  if (input['type'] !== undefined) {
    const type = parseType(input['type'])
    if ('error' in type) return type
    // The stored config belongs to the old type; keeping it under another one would also change what is masked.
    if (type.value !== existing.type && input['config'] === undefined) return { error: 'Changing the type needs a new config in the same request' }
    patch.type = type.value
  }
  for (const [field, range] of [['intervalSecs', INTERVAL_SECS_RANGE], ['timeoutMs', TIMEOUT_MS_RANGE], ['retries', RETRIES_RANGE]] as const) {
    const value = input[field]
    if (value === undefined) continue
    if (!inRange(value, range)) return { error: rangeError(field, range) }
    patch[field] = value
  }
  if (input['failureThreshold'] !== undefined) patch.failureThreshold = clampThreshold(input['failureThreshold'], existing.failureThreshold)
  if (input['recoveryThreshold'] !== undefined) patch.recoveryThreshold = clampThreshold(input['recoveryThreshold'], existing.recoveryThreshold)
  const auto = parseAutoIncident(input)
  if ('error' in auto) return auto
  Object.assign(patch, auto.value)
  if (input['config'] !== undefined) {
    const config = parseConfig(patch.type ?? existing.type as MonitorType, input['config'])
    if ('error' in config) return config
    patch.config = config.value
  }
  if (input['tags'] !== undefined) {
    const tags = parseTags(input['tags'])
    if ('error' in tags) return tags
    patch.tags = tags.value
  }
  return { value: patch }
}
