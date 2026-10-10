import type { MonitorTag, MonitorType } from '@bsp/shared'
import { validateDockerConfig } from '../workers/docker.js'

export const MONITOR_TYPES: readonly MonitorType[] = ['https', 'ping', 'dns', 'sqlserver', 'postgresql', 'mysql', 'mongodb', 'docker', 'webhook']

export const INTERVAL_SECS_RANGE = [10, 86_400] as const
export const TIMEOUT_MS_RANGE = [1_000, 300_000] as const
export const RETRIES_RANGE = [1, 10] as const
export const THRESHOLD_RANGE = [1, 20] as const
const MAX_NAME_LENGTH = 200
const MAX_TAGS = 20

export interface MonitorFields {
  name: string
  type: MonitorType
  intervalSecs: number
  timeoutMs: number
  retries: number
  failureThreshold: number
  recoveryThreshold: number
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

function parseConfig(type: MonitorType, value: unknown): Parsed<Record<string, unknown>> {
  if (!isRecord(value)) return { error: 'config must be an object' }
  if (type === 'docker') {
    const invalid = validateDockerConfig(value)
    if (invalid) return { error: invalid }
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

  return {
    value: {
      name: name.value, type: type.value, intervalSecs, timeoutMs, retries,
      failureThreshold: clampThreshold(input['failureThreshold'], 1),
      recoveryThreshold: clampThreshold(input['recoveryThreshold'], 1),
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
