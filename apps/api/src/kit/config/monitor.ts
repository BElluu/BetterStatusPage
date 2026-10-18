import { eq, or } from 'drizzle-orm'
import { isValidEntityKey, byKey, canonical, clip, documentKey, findCycle, isObject, keyList, nestedDeeperThan, unknownFields, type AuditEntry, type ConfigChange, type ConfigKind, type Json, type Problems } from '@better-kit/config-as-code'
import type { AutoIncidentMode } from '@bsp/shared'
import { tokenAllows } from '@better-kit/contracts'
import { db } from '../../db/client.js'
import { monitorActions, monitorDependencies, monitorNotificationChannels, monitors } from '../../db/schema.js'
import { AUTO_INCIDENT_MINUTES_RANGE, certResetsFor, generateWebhookToken, parseNewMonitor, THRESHOLD_RANGE, WEBHOOK_TOKEN_PATTERN, type MonitorFields } from '../../services/monitorInput.js'
import { maskSecrets, restoreSecrets, SECRET_MASK } from '../../services/secretFields.js'
import { vaultUseProblem } from '../vaultUse.js'
import { cancelRunsOfMonitor, cancelUnlinkedRuns } from '../../workers/actionRunner.js'
import { parseActionLinks, type DesiredAction, type DesiredActionLink } from './action.js'
import { mayLinkChannels, type DesiredChannel } from './channel.js'
import type { ExportState, State } from './state.js'
import { entityKeys, exportByKey, linkOrder, MAX_CONFIG_DEPTH, missingLink } from './shared.js'

const MONITOR_FIELDS = ['kind', 'key', 'name', 'type', 'intervalSecs', 'timeoutMs', 'retries', 'failureThreshold', 'recoveryThreshold', 'config', 'tags', 'notifications', 'dependsOn', 'autoIncident', 'actions', 'heartbeatToken']
const AUTO_INCIDENT_FIELDS = ['enabled', 'afterMinutes', 'mode', 'template']

export interface DesiredMonitor {
  path: string
  key: string
  fields: MonitorFields
  notifications: string[]
  dependsOn: string[]
  /** Null when the document has no `actions` field: the links stay as they are. An empty list removes them. */
  actions: DesiredActionLink[] | null
  /** Null when the block is missing or `enabled: false`: automatic incidents are off. `template` is a name; null = the default one. */
  autoIncident: { afterMinutes: number; mode: AutoIncidentMode; template: string | null } | null
  /** Null when the document has no token or the mask: a webhook monitor keeps its stored token, a new one gets a random one. */
  heartbeatToken: string | null
}

type MonitorRow = typeof monitors.$inferSelect
interface AutoIncidentSettings { minutes: number | null; mode: AutoIncidentMode; templateId: number | null }
export interface PlannedMonitor { desired: DesiredMonitor; config: Json; existing: MonitorRow | undefined; fields: string[]; auto: AutoIncidentSettings }

const keysOf = (value: unknown, path: string, problems: Problems) => keyList(value, path, problems, isValidEntityKey)

function parseAutoIncident(value: unknown, path: string, problems: Problems): DesiredMonitor['autoIncident'] {
  if (value === undefined || value === null) return null
  const at = `${path}.autoIncident`
  if (!isObject(value)) { problems.add(at, 'must be an object: { afterMinutes, mode, template }'); return null }
  unknownFields(value, AUTO_INCIDENT_FIELDS, at, problems)
  if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') problems.add(`${at}.enabled`, 'must be true or false')
  if (value['enabled'] === false) return null

  const minutes = value['afterMinutes']
  const [min, max] = AUTO_INCIDENT_MINUTES_RANGE
  const validMinutes = typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= min && minutes <= max
  if (!validMinutes) problems.add(`${at}.afterMinutes`, `is required: a whole number from ${min} to ${max}`)
  const mode = value['mode'] ?? 'draft'
  if (mode !== 'draft' && mode !== 'published') problems.add(`${at}.mode`, 'must be draft or published')
  const template = value['template']
  if (template !== undefined && (typeof template !== 'string' || !template.trim())) problems.add(`${at}.template`, 'must be the name of an incident template')
  return validMinutes && (mode === 'draft' || mode === 'published')
    ? { afterMinutes: minutes, mode, template: typeof template === 'string' ? template : null }
    : null
}

/** The comparable form of a monitor's automatic-incident settings; null = off. */
function autoIncidentState(minutes: number | null, mode: string, templateId: number | null): Json | null {
  return minutes === null ? null : { afterMinutes: minutes, mode, templateId }
}

function resolveAutoIncident(monitor: DesiredMonitor, state: State, problems: Problems): AutoIncidentSettings {
  const wanted = monitor.autoIncident
  if (!wanted) return { minutes: null, mode: 'draft', templateId: null }
  if (wanted.template === null) return { minutes: wanted.afterMinutes, mode: wanted.mode, templateId: null }
  const found = state.templateRows.find((row) => row.name === wanted.template)
  if (!found) {
    problems.add(`${monitor.path}.autoIncident.template`, `unknown incident template "${clip(wanted.template)}"`)
    return { minutes: wanted.afterMinutes, mode: wanted.mode, templateId: null }
  }
  return { minutes: wanted.afterMinutes, mode: wanted.mode, templateId: found.isDefault ? null : found.id }
}

function parseHeartbeatToken(value: unknown, type: string | undefined, path: string, problems: Problems): string | null {
  if (value === undefined || value === SECRET_MASK) return null
  if (type !== undefined && type !== 'webhook') problems.add(`${path}.heartbeatToken`, 'only a webhook monitor has a heartbeat token')
  else if (typeof value !== 'string' || !WEBHOOK_TOKEN_PATTERN.test(value)) problems.add(`${path}.heartbeatToken`, 'must be 48 lowercase hexadecimal characters')
  return typeof value === 'string' ? value : null
}

function refusePublishing(path: string, problems: Problems) {
  problems.add(`${path}.autoIncident`, 'a token needs the "incidents:write" permission to publish automatic incidents or choose their template')
}

export const monitorKind: ConfigKind<State, ExportState, DesiredMonitor, PlannedMonitor[]> = {
  kind: 'Monitor',

  parse(entry, index, seen, problems) {
    const key = documentKey(entry, `document ${index + 1}`, seen, problems, entityKeys)
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
    const notifications = keysOf(entry['notifications'], `${path}.notifications`, problems)
    const dependsOn = keysOf(entry['dependsOn'], `${path}.dependsOn`, problems)
    const autoIncident = parseAutoIncident(entry['autoIncident'], path, problems)
    const actionLinks = parseActionLinks(entry['actions'], path, problems)
    const heartbeatToken = parseHeartbeatToken(entry['heartbeatToken'], 'value' in parsed ? parsed.value.type : undefined, path, problems)
    return key && 'value' in parsed ? { path, key, fields: parsed.value, notifications, dependsOn, actions: actionLinks, autoIncident, heartbeatToken } : null
  },

  plan(desired, ctx) {
    const { state, token, problems, resolveVaults } = ctx
    const monitorByKey = new Map(state.monitorRows.map((row) => [row.key, row]))
    const monitorKeyById = new Map(state.monitorRows.map((row) => [row.id, row.key]))
    const channelKeyById = new Map(state.channelRows.map((row) => [row.id, row.key]))
    const actionKeyById = new Map(state.actionRows.map((row) => [row.id, row.key]))

    // What exists afterwards: everything that is there now and the file adds, except what prune deletes.
    const survivors = (kind: string, rows: { key: string }[], documents: { key: string }[]) => {
      const removed = ctx.removed(kind)
      return new Set([...rows.map((row) => row.key).filter((key) => !removed.has(key)), ...documents.map((document) => document.key)])
    }
    const finalMonitorKeys = survivors('Monitor', state.monitorRows, desired)
    const finalChannelKeys = survivors('NotificationChannel', state.channelRows, ctx.desired('NotificationChannel') as DesiredChannel[])
    const finalActionKeys = survivors('Action', state.actionRows, ctx.desired('Action') as DesiredAction[])

    const currentChannelKeys = (monitorId: number) =>
      state.linkRows.filter((link) => link.monitorId === monitorId).flatMap((link) => channelKeyById.get(link.channelId) ?? []).sort()
    const currentDependencies = (monitorId: number) =>
      state.dependencyRows.filter((edge) => edge.dependentId === monitorId).flatMap((edge) => monitorKeyById.get(edge.dependsOnId) ?? []).sort()
    const currentActionLinks = (monitorId: number) =>
      state.actionLinkRows.filter((link) => link.monitorId === monitorId).flatMap((link) => {
        const action = actionKeyById.get(link.actionId)
        return action ? [{ action, onStatus: link.onStatus, delayMinutes: link.delayMinutes, cooldownMinutes: link.cooldownMinutes }] : []
      }).sort(linkOrder)

    const changes: ConfigChange[] = []
    const planned: PlannedMonitor[] = []
    const edges = new Map<string, string[]>()
    for (const row of state.monitorRows) edges.set(row.key, currentDependencies(row.id))

    const tokenOwner = new Map(state.monitorRows.flatMap((row) => row.webhookToken ? [[row.webhookToken, row.key] as const] : []))
    for (const monitor of [...desired].sort(byKey)) {
      const existing = monitorByKey.get(monitor.key)
      const { fields: values } = monitor
      const stored = existing && existing.type === values.type ? JSON.parse(existing.config) : undefined
      const secrets = restoreSecrets('monitor', values.config, stored)
      if ('error' in secrets) problems.add(`${monitor.path}.config`, secrets.error)
      const config = 'config' in secrets ? resolveVaults(secrets.config, `${monitor.path}.config`) as Json : values.config
      const vaultProblem = vaultUseProblem(token, config, stored)
      if (vaultProblem) problems.add(`${monitor.path}.config`, vaultProblem)

      for (const key of monitor.notifications) if (!finalChannelKeys.has(key)) problems.add(`${monitor.path}.notifications`, missingLink('channel', key, ctx.removed('NotificationChannel')))
      for (const link of monitor.actions ?? []) if (!finalActionKeys.has(link.action)) problems.add(`${monitor.path}.actions`, missingLink('action', link.action, ctx.removed('Action')))
      for (const key of monitor.dependsOn) {
        if (key === monitor.key) problems.add(`${monitor.path}.dependsOn`, 'a monitor cannot depend on itself')
        else if (!finalMonitorKeys.has(key)) problems.add(`${monitor.path}.dependsOn`, missingLink('monitor', key, ctx.removed('Monitor')))
      }
      edges.set(monitor.key, monitor.dependsOn.filter((key) => finalMonitorKeys.has(key) && key !== monitor.key))

      if (monitor.heartbeatToken) {
        const owner = tokenOwner.get(monitor.heartbeatToken)
        if (owner && owner !== monitor.key) problems.add(`${monitor.path}.heartbeatToken`, 'is already used by another monitor')
        tokenOwner.set(monitor.heartbeatToken, monitor.key)
      }

      // Missing block or `enabled: false` = off. No template named = the default one, stored as null.
      const auto = resolveAutoIncident(monitor, state, problems)
      const mayPublish = !token || tokenAllows(token.scopes, 'incidents:write')

      const mayLink = mayLinkChannels(token)
      const refuseLinks = () => problems.add(`${monitor.path}.notifications`, 'a token needs the "channels:write" permission to change which channels a monitor alerts through')
      if (!existing) {
        if (monitor.notifications.length && !mayLink) refuseLinks()
        if (!mayPublish && (auto.mode === 'published' || auto.templateId !== null)) refusePublishing(monitor.path, problems)
        planned.push({ desired: monitor, config, existing, fields: [], auto })
        changes.push({ kind: 'Monitor', key: monitor.key, action: 'create' })
        continue
      }
      const current: Json = {
        name: existing.name, type: existing.type, intervalSecs: existing.intervalSecs, timeoutMs: existing.timeoutMs, retries: existing.retries,
        failureThreshold: existing.failureThreshold, recoveryThreshold: existing.recoveryThreshold,
        config: JSON.parse(existing.config), tags: JSON.parse(existing.tags ?? '[]'),
        notifications: currentChannelKeys(existing.id), dependsOn: currentDependencies(existing.id),
        actions: currentActionLinks(existing.id),
        autoIncident: autoIncidentState(existing.autoIncidentMinutes, existing.autoIncidentMode, existing.autoIncidentTemplateId),
        heartbeatToken: existing.webhookToken,
      }
      const wanted: Json = {
        name: values.name, type: values.type, intervalSecs: values.intervalSecs, timeoutMs: values.timeoutMs, retries: values.retries,
        failureThreshold: values.failureThreshold, recoveryThreshold: values.recoveryThreshold,
        config, tags: values.tags, notifications: [...monitor.notifications].sort(), dependsOn: [...monitor.dependsOn].sort(),
        // A document without an `actions` field leaves the links alone; only an empty list removes them.
        ...(monitor.actions !== null ? { actions: [...monitor.actions].sort(linkOrder) } : {}),
        autoIncident: autoIncidentState(auto.minutes, auto.mode, auto.templateId),
        ...(monitor.heartbeatToken ? { heartbeatToken: monitor.heartbeatToken } : {}),
      }
      const fields = Object.keys(wanted).filter((field) => canonical(current[field]) !== canonical(wanted[field]))
      if (fields.includes('notifications') && !mayLink) refuseLinks()
      if (fields.includes('autoIncident') && !mayPublish && (auto.mode === 'published' || auto.templateId !== null)) refusePublishing(monitor.path, problems)
      if (fields.length) planned.push({ desired: monitor, config, existing, fields, auto })
      changes.push({ kind: 'Monitor', key: monitor.key, action: fields.length ? 'update' : 'unchanged', ...(fields.length ? { fields } : {}) })
    }

    const cycle = findCycle(edges)
    if (cycle) problems.add('Monitor', `dependency cycle: ${cycle}`)
    return { planned, changes }
  },

  existingIds: (state) => new Map(state.monitorRows.map((row) => [row.key, row.id])),

  async remove(keys, { state, ids }) {
    const audit: AuditEntry[] = []
    for (const key of keys) {
      const id = ids('Monitor').get(key)!
      const row = state.monitorRows.find((each) => each.id === id)!
      await cancelRunsOfMonitor(id)
      await db.delete(monitorActions).where(eq(monitorActions.monitorId, id))
      await db.delete(monitorNotificationChannels).where(eq(monitorNotificationChannels.monitorId, id))
      await db.delete(monitorDependencies).where(or(eq(monitorDependencies.dependentId, id), eq(monitorDependencies.dependsOnId, id)))
      await db.delete(monitors).where(eq(monitors.id, id))
      audit.push({ action: 'delete', entity: 'monitor', id, name: row.name, diff: { key, type: row.type, source: 'configuration import' } })
    }
    return audit
  },

  // Monitors first without their links: a link may point at a monitor created later in the same stream.
  async apply(planned, { now, ids }) {
    const audit: AuditEntry[] = []
    const source = 'configuration import'
    for (const { desired: monitor, config, existing, fields, auto } of planned) {
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
        if (fields.includes('autoIncident')) {
          updates.autoIncidentMinutes = auto.minutes
          updates.autoIncidentMode = auto.mode
          updates.autoIncidentTemplateId = auto.templateId
        }
        if (fields.includes('config')) {
          updates.config = JSON.stringify(config)
          Object.assign(updates, certResetsFor(JSON.parse(existing.config), config))
        }
        // Only a webhook monitor has a heartbeat token; keep the one it has so its URL does not change.
        if (values.type !== 'webhook') updates.webhookToken = null
        else if (monitor.heartbeatToken) updates.webhookToken = monitor.heartbeatToken
        else if (!existing.webhookToken) updates.webhookToken = generateWebhookToken()
        if (fields.some((field) => !['notifications', 'dependsOn', 'actions'].includes(field))) {
          await db.update(monitors).set(updates).where(eq(monitors.id, existing.id))
        }
        audit.push({ action: 'update', entity: 'monitor', id: existing.id, name: existing.name, diff: { key: monitor.key, source, changed: fields.join(', ') } })
      } else {
        const [row] = await db.insert(monitors).values({
          key: monitor.key, name: values.name, type: values.type,
          intervalSecs: values.intervalSecs, timeoutMs: values.timeoutMs, retries: values.retries,
          failureThreshold: values.failureThreshold, recoveryThreshold: values.recoveryThreshold,
          config: JSON.stringify(config), tags: JSON.stringify(values.tags),
          autoIncidentMinutes: auto.minutes, autoIncidentMode: auto.mode, autoIncidentTemplateId: auto.templateId,
          currentStatus: 'pending', alertConfirmedStatus: 'pending',
          webhookToken: values.type === 'webhook' ? monitor.heartbeatToken ?? generateWebhookToken() : null,
          createdAt: now, updatedAt: now,
        }).returning({ id: monitors.id })
        ids('Monitor').set(monitor.key, row!.id)
        audit.push({ action: 'create', entity: 'monitor', id: row!.id, name: values.name, diff: { key: monitor.key, type: values.type, source } })
      }
    }
    return audit
  },

  async link(planned, { ids }) {
    const monitorId = ids('Monitor')
    const channelId = ids('NotificationChannel')
    const actionId = ids('Action')
    for (const { desired: monitor, existing, fields } of planned) {
      const id = monitorId.get(monitor.key)!
      if (!existing || fields.includes('notifications')) {
        await db.delete(monitorNotificationChannels).where(eq(monitorNotificationChannels.monitorId, id))
        if (monitor.notifications.length) {
          await db.insert(monitorNotificationChannels).values(monitor.notifications.map((key) => ({ monitorId: id, channelId: channelId.get(key)! })))
        }
      }
      if (monitor.actions !== null && (!existing || fields.includes('actions'))) {
        await db.delete(monitorActions).where(eq(monitorActions.monitorId, id))
        if (monitor.actions.length) {
          await db.insert(monitorActions).values(monitor.actions.map((link) => ({
            monitorId: id, actionId: actionId.get(link.action)!, onStatus: link.onStatus, delayMinutes: link.delayMinutes, cooldownMinutes: link.cooldownMinutes,
          })))
        }
        // Runs that wait for a link the file removed have no reason to run any more.
        await cancelUnlinkedRuns(id, monitor.actions.map((link) => ({ actionId: actionId.get(link.action)!, onStatus: link.onStatus })))
      }
      if (!existing || fields.includes('dependsOn')) {
        await db.delete(monitorDependencies).where(eq(monitorDependencies.dependentId, id))
        if (monitor.dependsOn.length) {
          await db.insert(monitorDependencies).values(monitor.dependsOn.map((key) => ({ dependentId: id, dependsOnId: monitorId.get(key)! })))
        }
      }
    }
  },

  export(state, ctx) {
    const includeActions = ctx.included('Action')
    const monitorKey = new Map(state.monitorRows.map((row) => [row.id, row.key]))
    const channelKey = new Map(state.channelRows.map((row) => [row.id, row.key]))
    const actionKey = new Map(state.actionRows.map((row) => [row.id, row.key]))
    const templateName = new Map(state.templateRows.map((row) => [row.id, row.name]))
    const keysOfIds = (ids: number[], lookup: Map<number, string>) => ids.flatMap((id) => lookup.get(id) ?? []).sort()

    return ctx.wanted(state.monitorRows, 'Monitor').map((row) => ({
      kind: 'Monitor' as const,
      key: row.key,
      name: row.name,
      type: row.type,
      intervalSecs: row.intervalSecs,
      timeoutMs: row.timeoutMs,
      retries: row.retries,
      failureThreshold: row.failureThreshold,
      recoveryThreshold: row.recoveryThreshold,
      config: ctx.exportVaultRefs(maskSecrets('monitor', JSON.parse(row.config))) as Json,
      tags: JSON.parse(row.tags ?? '[]'),
      ...(row.type === 'webhook' ? { heartbeatToken: SECRET_MASK } : {}),
      notifications: keysOfIds(state.linkRows.filter((link) => link.monitorId === row.id).map((link) => link.channelId), channelKey),
      dependsOn: keysOfIds(state.dependencyRows.filter((dependency) => dependency.dependentId === row.id).map((dependency) => dependency.dependsOnId), monitorKey),
      ...(includeActions ? {
        actions: state.actionLinkRows.filter((link) => link.monitorId === row.id).flatMap((link) => {
          const action = actionKey.get(link.actionId)
          return action ? [{ action, onStatus: link.onStatus, delayMinutes: link.delayMinutes, cooldownMinutes: link.cooldownMinutes }] : []
        }).sort(linkOrder),
      } : {}),
      ...(row.autoIncidentMinutes === null ? {} : {
        autoIncident: {
          afterMinutes: row.autoIncidentMinutes,
          mode: row.autoIncidentMode,
          ...(row.autoIncidentTemplateId !== null && templateName.has(row.autoIncidentTemplateId) ? { template: templateName.get(row.autoIncidentTemplateId)! } : {}),
        },
      }),
    })).sort(exportByKey)
  },
}
