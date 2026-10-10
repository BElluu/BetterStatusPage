import { eq } from 'drizzle-orm'
import { tokenAllows, type ChannelAlertPolicy, type NotificationChannelType } from '@bsp/shared'
import { db } from '../db/client.js'
import { withImmediateTransaction } from '../db/transaction.js'
import {
  monitorDependencies, monitorNotificationChannels, monitors, notificationChannels, vaultSecrets, vaults,
} from '../db/schema.js'
import { clip, nestedDeeperThan } from '../lib/clip.js'
import { isValidEntityKey, ENTITY_KEY_ERROR } from '../lib/entityKey.js'
import { normalizeAlertPolicy, parseAlertPolicy } from './alertPolicy.js'
import { writeAudit, type Actor } from './audit.js'
import { CHANNEL_TYPES, telegramConfigError } from './channelInput.js'
import { certResetsFor, generateWebhookToken, parseNewMonitor, THRESHOLD_RANGE, type MonitorFields } from './monitorInput.js'
import { refreshPublishedMonitorIds } from './publishedMonitors.js'
import { restoreSecrets } from './secretFields.js'
import { vaultUseProblem } from './vaultUse.js'

export interface ConfigProblem { path: string; message: string }

/** The file is not valid; `problems` lists what is wrong with it, not just the first thing. */
export class ConfigInvalidError extends Error {
  constructor(readonly problems: ConfigProblem[]) {
    super(problems[0] ? `${problems[0].path}: ${problems[0].message}` : 'Invalid configuration')
  }
}

/** What a document describes. A file is a stream of documents, each with a `kind`. */
export const DOCUMENT_KINDS = ['Monitor', 'NotificationChannel'] as const
export type DocumentKind = typeof DOCUMENT_KINDS[number]

export type ChangeAction = 'create' | 'update' | 'unchanged'

export interface ConfigChange {
  kind: DocumentKind
  /** The key of the monitor or channel. */
  key?: string
  action: ChangeAction
  /** For an update: which settings differ. Never their values, which may be secrets. */
  fields?: string[]
}

export interface ImportResult {
  dryRun: boolean
  summary: Record<ChangeAction, number>
  changes: ConfigChange[]
}

export interface ImportOptions {
  dryRun: boolean
  actor: Actor
  /** Set when the request is made with an API token: what it may do decides if vault references may be used. */
  token?: { scopes: readonly string[] } | undefined
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

const MAX_PROBLEMS = 100
const MAX_NAME_LENGTH = 200
const MAX_CONFIG_DEPTH = 20
const CHANNEL_FIELDS = ['kind', 'key', 'name', 'type', 'enabled', 'notifyOnRecovery', 'config', 'alertPolicy']
const MONITOR_FIELDS = ['kind', 'key', 'name', 'type', 'intervalSecs', 'timeoutMs', 'retries', 'failureThreshold', 'recoveryThreshold', 'config', 'tags', 'notifications', 'dependsOn']

/** The kinds a list of documents contains, so that the caller can check it may import each. Documents of no known kind are ignored here. */
export function kindsIn(documents: unknown[]): Set<DocumentKind> {
  const found = new Set<DocumentKind>()
  for (const document of documents) {
    if (isObject(document) && (DOCUMENT_KINDS as readonly unknown[]).includes(document['kind'])) found.add(document['kind'] as DocumentKind)
  }
  return found
}

/** The same value written with its keys in a fixed order, so equal settings compare equal whatever their order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => isObject(inner) ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]])) : inner)
}

class Problems {
  readonly list: ConfigProblem[] = []
  add = (path: string, message: string) => { if (this.list.length < MAX_PROBLEMS) this.list.push({ path, message }) }
  get any() { return this.list.length > 0 }
}

// ── The documents ───────────────────────────────────────────────────────────────────────────────────────────────

interface DesiredChannel {
  path: string
  key: string
  name: string
  type: NotificationChannelType
  enabled: boolean
  notifyOnRecovery: boolean
  config: Json
  alertPolicy: ChannelAlertPolicy
}

interface DesiredMonitor {
  path: string
  key: string
  fields: MonitorFields
  notifications: string[]
  dependsOn: string[]
}

interface Desired {
  channels: DesiredChannel[]
  monitors: DesiredMonitor[]
}

function unknownFields(entry: Json, allowed: readonly string[], path: string, problems: Problems) {
  for (const field of Object.keys(entry)) if (!allowed.includes(field)) problems.add(`${path}.${clip(field)}`, 'is not a known setting')
}

function keyList(value: unknown, path: string, problems: Problems): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    problems.add(path, 'must be a list of keys')
    return []
  }
  for (const key of value) if (!isValidEntityKey(key)) problems.add(path, `"${clip(key)}" is not a valid key`)
  return [...new Set(value as string[])]
}

/** The key of a monitor or channel document, or '' (with a problem) when it has none that is usable. */
function documentKey(entry: Json, path: string, seen: Set<string>, problems: Problems): string {
  const key = entry['key']
  if (!isValidEntityKey(key)) {
    problems.add(`${path}.key`, key === undefined ? 'is required' : ENTITY_KEY_ERROR)
    return ''
  }
  if (seen.has(key)) problems.add(`${path}.key`, `"${clip(key)}" is used by another document`)
  seen.add(key)
  return key
}

/** Every setting the file gives must be one the policy has, with a value it accepts: the normaliser would otherwise quietly replace it. */
function policyProblems(given: unknown, normalized: unknown, path: string, problems: Problems) {
  if (!isObject(given)) { problems.add(path, 'must be an object'); return }
  for (const [key, value] of Object.entries(given)) {
    if (!isObject(normalized) || !(key in normalized)) { problems.add(`${path}.${clip(key)}`, 'is not a known setting'); continue }
    const expected = normalized[key]
    if (isObject(expected)) policyProblems(value, expected, `${path}.${key}`, problems)
    else if (canonical(value) !== canonical(expected)) problems.add(`${path}.${key}`, 'is not a valid value')
  }
}

function parseChannel(entry: Json, index: number, seen: Set<string>, problems: Problems): DesiredChannel | null {
  const key = documentKey(entry, `document ${index + 1}`, seen, problems)
  const path = key ? `NotificationChannel[${key}]` : `document ${index + 1}`
  unknownFields(entry, CHANNEL_FIELDS, path, problems)

  const name = entry['name']
  if (typeof name !== 'string' || !name.trim()) problems.add(`${path}.name`, 'is required')
  else if (name.length > MAX_NAME_LENGTH) problems.add(`${path}.name`, `must be at most ${MAX_NAME_LENGTH} characters`)
  const type = entry['type']
  if (!CHANNEL_TYPES.includes(type as NotificationChannelType)) problems.add(`${path}.type`, `must be one of: ${CHANNEL_TYPES.join(', ')}`)
  for (const flag of ['enabled', 'notifyOnRecovery'] as const) {
    if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') problems.add(`${path}.${flag}`, 'must be true or false')
  }
  const config = entry['config'] ?? {}
  if (!isObject(config)) problems.add(`${path}.config`, 'must be an object')
  else if (nestedDeeperThan(config, MAX_CONFIG_DEPTH)) problems.add(`${path}.config`, `is nested deeper than ${MAX_CONFIG_DEPTH} levels`)
  const alertPolicy = normalizeAlertPolicy(entry['alertPolicy'])
  if (entry['alertPolicy'] !== undefined) policyProblems(entry['alertPolicy'], alertPolicy, `${path}.alertPolicy`, problems)

  if (!key || typeof name !== 'string' || !CHANNEL_TYPES.includes(type as NotificationChannelType) || !isObject(config)) return null
  return {
    path, key, name, type: type as NotificationChannelType, config,
    enabled: entry['enabled'] !== false,
    notifyOnRecovery: entry['notifyOnRecovery'] === true,
    alertPolicy,
  }
}

function parseMonitor(entry: Json, index: number, seen: Set<string>, problems: Problems): DesiredMonitor | null {
  const key = documentKey(entry, `document ${index + 1}`, seen, problems)
  const path = key ? `Monitor[${key}]` : `document ${index + 1}`
  unknownFields(entry, MONITOR_FIELDS, path, problems)

  const parsed = parseNewMonitor(entry)
  if ('error' in parsed) problems.add(path, parsed.error)
  // The API clamps a threshold into range; a file that asks for 50 or "3" has made a mistake worth saying so.
  for (const field of ['failureThreshold', 'recoveryThreshold'] as const) {
    const value = entry[field]
    if (value !== undefined && !(Number.isInteger(value) && (value as number) >= THRESHOLD_RANGE[0] && (value as number) <= THRESHOLD_RANGE[1])) {
      problems.add(`${path}.${field}`, `must be a whole number from ${THRESHOLD_RANGE[0]} to ${THRESHOLD_RANGE[1]}`)
    }
  }
  if (nestedDeeperThan(entry['config'], MAX_CONFIG_DEPTH)) problems.add(`${path}.config`, `is nested deeper than ${MAX_CONFIG_DEPTH} levels`)
  const notifications = keyList(entry['notifications'], `${path}.notifications`, problems)
  const dependsOn = keyList(entry['dependsOn'], `${path}.dependsOn`, problems)
  return key && 'value' in parsed ? { path, key, fields: parsed.value, notifications, dependsOn } : null
}

/** Where a name the parser would treat specially (`__proto__`) appears in a document, or null. Walks without recursion. */
function forbiddenNameAt(document: unknown, label: string): string | null {
  const pending: Array<[unknown, string]> = [[document, label]]
  while (pending.length) {
    const [value, path] = pending.pop()!
    if (!value || typeof value !== 'object') continue
    if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, '__proto__')) return `${path}.__proto__`
    const entries: Array<[string, unknown]> = Array.isArray(value) ? value.map((item, index) => [`[${index}]`, item]) : Object.entries(value)
    for (const [name, inner] of entries) pending.push([inner, name.startsWith('[') ? `${path}${name}` : `${path}.${clip(name)}`])
  }
  return null
}

function parseDocuments(documents: unknown[], problems: Problems): Desired {
  const desired: Desired = { channels: [], monitors: [] }
  const channelKeys = new Set<string>()
  const monitorKeys = new Set<string>()

  documents.forEach((document, index) => {
    const label = `document ${index + 1}`
    const poisoned = forbiddenNameAt(document, label)
    if (poisoned) { problems.add(poisoned, '"__proto__" is not allowed as a name'); return }
    if (!isObject(document)) { problems.add(label, 'must be an object with a kind'); return }

    switch (document['kind']) {
      case 'Monitor': {
        const monitor = parseMonitor(document, index, monitorKeys, problems)
        if (monitor) desired.monitors.push(monitor)
        break
      }
      case 'NotificationChannel': {
        const channel = parseChannel(document, index, channelKeys, problems)
        if (channel) desired.channels.push(channel)
        break
      }
      default:
        problems.add(`${label}.kind`, document['kind'] === undefined ? `is required: one of ${DOCUMENT_KINDS.join(', ')}` : `"${clip(String(document['kind']))}" is not a kind; use one of ${DOCUMENT_KINDS.join(', ')}`)
    }
  })
  return desired
}

// ── The installation ────────────────────────────────────────────────────────────────────────────────────────────

type MonitorRow = typeof monitors.$inferSelect
type ChannelRow = typeof notificationChannels.$inferSelect

async function loadState() {
  const [monitorRows, channelRows, linkRows, dependencyRows, vaultRows, secretRows] = await Promise.all([
    db.select().from(monitors),
    db.select().from(notificationChannels),
    db.select().from(monitorNotificationChannels),
    db.select().from(monitorDependencies),
    db.select({ id: vaults.id, name: vaults.name }).from(vaults),
    db.select({ id: vaultSecrets.id, vaultId: vaultSecrets.vaultId, name: vaultSecrets.name }).from(vaultSecrets),
  ])
  return { monitorRows, channelRows, linkRows, dependencyRows, vaultRows, secretRows }
}

type State = Awaited<ReturnType<typeof loadState>>

/** `{ vault: 'Production', secret: 'db-login' }` back to the ids this installation knows them by. */
function vaultResolver(state: State) {
  const vaultsByName = new Map<string, number[]>()
  for (const vault of state.vaultRows) vaultsByName.set(vault.name, [...(vaultsByName.get(vault.name) ?? []), vault.id])
  const secretId = new Map(state.secretRows.map((secret) => [`${secret.vaultId}:${secret.name}`, secret.id]))

  return function resolve(value: unknown, path: string, problems: Problems): unknown {
    if (Array.isArray(value)) return value.map((item, index) => resolve(item, `${path}[${index}]`, problems))
    if (!isObject(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => {
      if (key !== 'vault') return [key, resolve(inner, `${path}.${key}`, problems)]
      const at = `${path}.vault`
      if (!isObject(inner) || typeof inner['vault'] !== 'string' || typeof inner['secret'] !== 'string') {
        problems.add(at, 'must name the vault and the secret: { vault: <name>, secret: <name> }')
        return [key, inner]
      }
      if ('vaultId' in inner || 'secretId' in inner) problems.add(at, 'a configuration file names a vault secret, it does not use numeric ids')
      const found = vaultsByName.get(inner['vault']) ?? []
      if (found.length !== 1) {
        problems.add(at, found.length === 0
          ? (inner['vault'].startsWith('(deleted') ? `${clip(inner['vault'])} refers to a vault that no longer exists` : `unknown vault "${clip(inner['vault'])}"`)
          : `more than one vault is named "${clip(inner['vault'])}"; rename one of them`)
        return [key, inner]
      }
      const secret = secretId.get(`${found[0]}:${inner['secret']}`)
      if (secret === undefined) {
        problems.add(at, inner['secret'].startsWith('(deleted') ? `${clip(inner['secret'])} refers to a secret that no longer exists` : `vault "${clip(inner['vault'])}" has no secret "${clip(inner['secret'])}"`)
        return [key, inner]
      }
      return [key, { vaultId: found[0], secretId: secret, ...(isObject(inner['fieldMapping']) ? { fieldMapping: inner['fieldMapping'] } : {}) }]
    }))
  }
}

// ── The plan ────────────────────────────────────────────────────────────────────────────────────────────────────

interface PlannedChannel { desired: DesiredChannel; config: Json; existing: ChannelRow | undefined; fields: string[] }
interface PlannedMonitor { desired: DesiredMonitor; config: Json; existing: MonitorRow | undefined; fields: string[] }
interface Planned {
  channels: PlannedChannel[]
  monitors: PlannedMonitor[]
  changes: ConfigChange[]
}

/** A dependency cycle among the monitors as they will be, as `a → b → a`, or null. */
function findCycle(edges: Map<string, string[]>): string | null {
  const done = new Set<string>()
  const stack: string[] = []
  const visit = (key: string): string | null => {
    const at = stack.indexOf(key)
    if (at >= 0) return [...stack.slice(at), key].join(' → ')
    if (done.has(key)) return null
    stack.push(key)
    for (const next of edges.get(key) ?? []) {
      const cycle = visit(next)
      if (cycle) return cycle
    }
    stack.pop()
    done.add(key)
    return null
  }
  for (const key of edges.keys()) {
    const cycle = visit(key)
    if (cycle) return cycle
  }
  return null
}

const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : 1)

function plan(state: State, desired: Desired, token: ImportOptions['token']): Planned {
  const problems = new Problems()
  const resolveVaults = vaultResolver(state)

  const monitorByKey = new Map(state.monitorRows.map((row) => [row.key, row]))
  const channelByKey = new Map(state.channelRows.map((row) => [row.key, row]))
  const monitorKeyById = new Map(state.monitorRows.map((row) => [row.id, row.key]))
  const channelKeyById = new Map(state.channelRows.map((row) => [row.id, row.key]))

  // What exists afterwards: everything that is there now, and everything the file adds.
  const finalMonitorKeys = new Set([...state.monitorRows.map((row) => row.key), ...desired.monitors.map((monitor) => monitor.key)])
  const finalChannelKeys = new Set([...state.channelRows.map((row) => row.key), ...desired.channels.map((channel) => channel.key)])

  const currentChannelKeys = (monitorId: number) =>
    state.linkRows.filter((link) => link.monitorId === monitorId).flatMap((link) => channelKeyById.get(link.channelId) ?? []).sort()
  const currentDependencies = (monitorId: number) =>
    state.dependencyRows.filter((edge) => edge.dependentId === monitorId).flatMap((edge) => monitorKeyById.get(edge.dependsOnId) ?? []).sort()

  const changes: ConfigChange[] = []
  const plannedChannels: PlannedChannel[] = []
  const plannedMonitors: PlannedMonitor[] = []

  for (const channel of [...desired.channels].sort(byKey)) {
    const existing = channelByKey.get(channel.key)
    const stored = existing && existing.type === channel.type ? JSON.parse(existing.config) : undefined
    const secrets = restoreSecrets('channel', channel.config, stored)
    if ('error' in secrets) { problems.add(`${channel.path}.config`, secrets.error); continue }
    const config = resolveVaults(secrets.config, `${channel.path}.config`, problems) as Json
    const vaultProblem = vaultUseProblem(token, config, stored)
    if (vaultProblem) problems.add(`${channel.path}.config`, vaultProblem)
    if (channel.type === 'telegram') {
      const problem = telegramConfigError(config)
      if (problem) problems.add(`${channel.path}.config`, problem)
    }
    if (!existing) {
      plannedChannels.push({ desired: channel, config, existing, fields: [] })
      changes.push({ kind: 'NotificationChannel', key: channel.key, action: 'create' })
      continue
    }
    const current: Json = {
      name: existing.name, type: existing.type, enabled: existing.enabled === 1, notifyOnRecovery: existing.notifyOnRecovery === 1,
      config: JSON.parse(existing.config), alertPolicy: parseAlertPolicy(existing.alertPolicy),
    }
    const wanted: Json = { name: channel.name, type: channel.type, enabled: channel.enabled, notifyOnRecovery: channel.notifyOnRecovery, config, alertPolicy: channel.alertPolicy }
    const fields = Object.keys(wanted).filter((field) => canonical(current[field]) !== canonical(wanted[field]))
    if (fields.length) plannedChannels.push({ desired: channel, config, existing, fields })
    changes.push({ kind: 'NotificationChannel', key: channel.key, action: fields.length ? 'update' : 'unchanged', ...(fields.length ? { fields } : {}) })
  }

  const edges = new Map<string, string[]>()
  for (const row of state.monitorRows) edges.set(row.key, currentDependencies(row.id))

  for (const monitor of [...desired.monitors].sort(byKey)) {
    const existing = monitorByKey.get(monitor.key)
    const { fields: values } = monitor
    const stored = existing && existing.type === values.type ? JSON.parse(existing.config) : undefined
    const secrets = restoreSecrets('monitor', values.config, stored)
    if ('error' in secrets) problems.add(`${monitor.path}.config`, secrets.error)
    const config = 'config' in secrets ? resolveVaults(secrets.config, `${monitor.path}.config`, problems) as Json : values.config
    const vaultProblem = vaultUseProblem(token, config, stored)
    if (vaultProblem) problems.add(`${monitor.path}.config`, vaultProblem)

    for (const key of monitor.notifications) if (!finalChannelKeys.has(key)) problems.add(`${monitor.path}.notifications`, `unknown channel "${clip(key)}"`)
    for (const key of monitor.dependsOn) {
      if (key === monitor.key) problems.add(`${monitor.path}.dependsOn`, 'a monitor cannot depend on itself')
      else if (!finalMonitorKeys.has(key)) problems.add(`${monitor.path}.dependsOn`, `unknown monitor "${clip(key)}"`)
    }
    edges.set(monitor.key, monitor.dependsOn.filter((key) => finalMonitorKeys.has(key) && key !== monitor.key))

    const mayLink = !token || tokenAllows(token.scopes, 'channels:write')
    const refuseLinks = () => problems.add(`${monitor.path}.notifications`, 'a token needs the "channels:write" permission to change which channels a monitor alerts through')
    if (!existing) {
      if (monitor.notifications.length && !mayLink) refuseLinks()
      plannedMonitors.push({ desired: monitor, config, existing, fields: [] })
      changes.push({ kind: 'Monitor', key: monitor.key, action: 'create' })
      continue
    }
    const current: Json = {
      name: existing.name, type: existing.type, intervalSecs: existing.intervalSecs, timeoutMs: existing.timeoutMs, retries: existing.retries,
      failureThreshold: existing.failureThreshold, recoveryThreshold: existing.recoveryThreshold,
      config: JSON.parse(existing.config), tags: JSON.parse(existing.tags ?? '[]'),
      notifications: currentChannelKeys(existing.id), dependsOn: currentDependencies(existing.id),
    }
    const wanted: Json = {
      name: values.name, type: values.type, intervalSecs: values.intervalSecs, timeoutMs: values.timeoutMs, retries: values.retries,
      failureThreshold: values.failureThreshold, recoveryThreshold: values.recoveryThreshold,
      config, tags: values.tags, notifications: [...monitor.notifications].sort(), dependsOn: [...monitor.dependsOn].sort(),
    }
    const fields = Object.keys(wanted).filter((field) => canonical(current[field]) !== canonical(wanted[field]))
    if (fields.includes('notifications') && !mayLink) refuseLinks()
    if (fields.length) plannedMonitors.push({ desired: monitor, config, existing, fields })
    changes.push({ kind: 'Monitor', key: monitor.key, action: fields.length ? 'update' : 'unchanged', ...(fields.length ? { fields } : {}) })
  }

  const cycle = findCycle(edges)
  if (cycle) problems.add('Monitor', `dependency cycle: ${cycle}`)

  if (problems.any) throw new ConfigInvalidError(problems.list)
  return { channels: plannedChannels, monitors: plannedMonitors, changes }
}

// ── The write ───────────────────────────────────────────────────────────────────────────────────────────────────

interface AuditEntry { action: 'create' | 'update'; entity: 'monitor' | 'notification_channel'; id: number | string; name: string; diff: Json }

async function execute(state: State, planned: Planned): Promise<AuditEntry[]> {
  const now = Date.now()
  const audit: AuditEntry[] = []
  const source = 'configuration import'

  const channelId = new Map(state.channelRows.map((row) => [row.key, row.id]))
  const monitorId = new Map(state.monitorRows.map((row) => [row.key, row.id]))

  for (const { desired: channel, config, existing, fields } of planned.channels) {
    const values = {
      name: channel.name, type: channel.type, config: JSON.stringify(config),
      enabled: channel.enabled ? 1 : 0, notifyOnRecovery: channel.notifyOnRecovery ? 1 : 0, alertPolicy: JSON.stringify(channel.alertPolicy),
    }
    if (existing) {
      await db.update(notificationChannels).set({ ...values, updatedAt: now }).where(eq(notificationChannels.id, existing.id))
      audit.push({ action: 'update', entity: 'notification_channel', id: existing.id, name: existing.name, diff: { key: channel.key, source, changed: fields.join(', ') } })
    } else {
      const [row] = await db.insert(notificationChannels).values({ key: channel.key, ...values, createdAt: now, updatedAt: now }).returning({ id: notificationChannels.id })
      channelId.set(channel.key, row!.id)
      audit.push({ action: 'create', entity: 'notification_channel', id: row!.id, name: channel.name, diff: { key: channel.key, type: channel.type, source } })
    }
  }

  // Monitors first without their links: a link may point at a monitor created later in the same stream.
  for (const { desired: monitor, config, existing, fields } of planned.monitors) {
    const values = monitor.fields
    if (existing) {
      const updates: Partial<typeof monitors.$inferInsert> = { updatedAt: now }
      if (fields.includes('name')) updates.name = values.name
      if (fields.includes('type')) updates.type = values.type
      if (fields.includes('intervalSecs')) updates.intervalSecs = values.intervalSecs
      if (fields.includes('timeoutMs')) updates.timeoutMs = values.timeoutMs
      if (fields.includes('retries')) updates.retries = values.retries
      if (fields.includes('failureThreshold')) updates.failureThreshold = values.failureThreshold
      if (fields.includes('recoveryThreshold')) updates.recoveryThreshold = values.recoveryThreshold
      if (fields.includes('tags')) updates.tags = JSON.stringify(values.tags)
      if (fields.includes('config')) {
        updates.config = JSON.stringify(config)
        Object.assign(updates, certResetsFor(JSON.parse(existing.config), config))
      }
      // Only a webhook monitor has a heartbeat token; keep the one it has so its URL does not change.
      if (values.type !== 'webhook') updates.webhookToken = null
      else if (!existing.webhookToken) updates.webhookToken = generateWebhookToken()
      if (fields.some((field) => !['notifications', 'dependsOn'].includes(field))) {
        await db.update(monitors).set(updates).where(eq(monitors.id, existing.id))
      }
      audit.push({ action: 'update', entity: 'monitor', id: existing.id, name: existing.name, diff: { key: monitor.key, source, changed: fields.join(', ') } })
    } else {
      const [row] = await db.insert(monitors).values({
        key: monitor.key, name: values.name, type: values.type,
        intervalSecs: values.intervalSecs, timeoutMs: values.timeoutMs, retries: values.retries,
        failureThreshold: values.failureThreshold, recoveryThreshold: values.recoveryThreshold,
        config: JSON.stringify(config), tags: JSON.stringify(values.tags),
        currentStatus: 'pending', alertConfirmedStatus: 'pending',
        webhookToken: values.type === 'webhook' ? generateWebhookToken() : null,
        createdAt: now, updatedAt: now,
      }).returning({ id: monitors.id })
      monitorId.set(monitor.key, row!.id)
      audit.push({ action: 'create', entity: 'monitor', id: row!.id, name: values.name, diff: { key: monitor.key, type: values.type, source } })
    }
  }

  for (const { desired: monitor, existing, fields } of planned.monitors) {
    const id = monitorId.get(monitor.key)!
    if (!existing || fields.includes('notifications')) {
      await db.delete(monitorNotificationChannels).where(eq(monitorNotificationChannels.monitorId, id))
      if (monitor.notifications.length) {
        await db.insert(monitorNotificationChannels).values(monitor.notifications.map((key) => ({ monitorId: id, channelId: channelId.get(key)! })))
      }
    }
    if (!existing || fields.includes('dependsOn')) {
      await db.delete(monitorDependencies).where(eq(monitorDependencies.dependentId, id))
      if (monitor.dependsOn.length) {
        await db.insert(monitorDependencies).values(monitor.dependsOn.map((key) => ({ dependentId: id, dependsOnId: monitorId.get(key)! })))
      }
    }
  }

  return audit
}

// ── Entry point ─────────────────────────────────────────────────────────────────────────────────────────────────

function summarise(changes: ConfigChange[]): ImportResult['summary'] {
  const summary = { create: 0, update: 0, unchanged: 0 }
  for (const change of changes) summary[change.action] += 1
  return summary
}

/**
 * Makes the installation match the documents: a monitor or channel whose key exists is updated, one whose key does
 * not is created. Nothing is ever removed. Everything is checked before anything is
 * written, and the writes are one transaction, so a stream is applied completely or not at all. With `dryRun`
 * nothing is written and the result says what would happen.
 */
export async function importConfig(documents: unknown[], options: ImportOptions): Promise<ImportResult> {
  const problems = new Problems()
  const desired = parseDocuments(documents, problems)
  if (problems.any) throw new ConfigInvalidError(problems.list)

  const result = (planned: Planned): ImportResult => ({ dryRun: options.dryRun, summary: summarise(planned.changes), changes: planned.changes })

  if (options.dryRun) return result(plan(await loadState(), desired, options.token))

  const { planned, audit } = await withImmediateTransaction(async () => {
    const state = await loadState()
    const planned = plan(state, desired, options.token)
    const audit = planned.changes.some((change) => change.action !== 'unchanged') ? await execute(state, planned) : []
    return { planned, audit }
  })

  // The changes are committed. A failure past this point must not turn a successful import into an error (the
  // client would retry, and a second apply is a no-op), so it is logged instead.
  if (audit.length) {
    try {
      await refreshPublishedMonitorIds()
      for (const entry of audit) await writeAudit(options.actor, entry.action, entry.entity, entry.id, entry.name, entry.diff)
      const summary = summarise(planned.changes)
      await writeAudit(options.actor, 'update', 'config', null, 'Configuration import', {
        created: summary.create, updated: summary.update, unchanged: summary.unchanged,
      })
    } catch (error) {
      console.error('[config] Imported, but could not finish the follow-up work:', error)
    }
  }
  return result(planned)
}
