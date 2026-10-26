import { eq } from 'drizzle-orm'
import { cancelRunsOfAction } from '../../workers/actionRunner.js'
import { ENTITY_KEY_ERROR, isValidEntityKey, byKey, canonical, documentKey, isObject, keyList, nestedDeeperThan, unknownFields, type AuditEntry, type ConfigChange, type ConfigKind, type Json, type Problems } from '@better-kit/config-as-code'
import { ACTION_TRIGGER_STATUSES, DEFAULT_APPROVAL_TIMEOUT_MINUTES, type ActionTriggerStatus } from '@bsp/shared'
import { db } from '../../db/client.js'
import { actionNotificationChannels, actions, monitorActions } from '../../db/schema.js'
import { actionConfigError, actionSecretTypeProblem } from '../../services/actionInput.js'
import { maskSecrets, restoreSecrets } from '../../services/secretFields.js'
import { vaultUseProblem } from '../vaultUse.js'
import type { DesiredChannel } from './channel.js'
import { mayLinkChannels } from './channel.js'
import type { ExportState, State } from './state.js'
import { entityKeys, exportByKey, MAX_CONFIG_DEPTH, MAX_NAME_LENGTH, missingLink } from './shared.js'

const ACTION_FIELDS = ['kind', 'key', 'name', 'enabled', 'requiresApproval', 'approvalTimeoutMinutes', 'config', 'notifications', 'failureNotifications']
const ACTION_LINK_FIELDS = ['action', 'onStatus', 'delayMinutes', 'cooldownMinutes']
const MAX_ACTION_MINUTES = 7 * 24 * 60

export interface DesiredAction {
  path: string
  key: string
  name: string
  enabled: boolean
  requiresApproval: boolean
  approvalTimeoutMinutes: number
  config: Json
  notifications: string[]
}

export interface DesiredActionLink { action: string; onStatus: ActionTriggerStatus; delayMinutes: number; cooldownMinutes: number }

type ActionRow = typeof actions.$inferSelect
export interface PlannedAction { desired: DesiredAction; config: Json; existing: ActionRow | undefined; fields: string[] }

const keysOf = (value: unknown, path: string, problems: Problems) => keyList(value, path, problems, isValidEntityKey)

/** The `actions` list of a monitor document, or null when the document does not have one. */
export function parseActionLinks(value: unknown, path: string, problems: Problems): DesiredActionLink[] | null {
  if (value === undefined) return null
  const at = `${path}.actions`
  if (!Array.isArray(value)) { problems.add(at, 'must be a list: [{ action, onStatus, delayMinutes, cooldownMinutes }]'); return null }
  const links: DesiredActionLink[] = []
  const seen = new Set<string>()
  value.forEach((item, index) => {
    const here = `${at}[${index}]`
    if (!isObject(item)) { problems.add(here, 'must be an object: { action, onStatus, delayMinutes, cooldownMinutes }'); return }
    unknownFields(item, ACTION_LINK_FIELDS, here, problems)
    const action = item['action']
    if (!isValidEntityKey(action)) problems.add(`${here}.action`, action === undefined ? 'is required: the key of an action' : ENTITY_KEY_ERROR)
    const onStatus = item['onStatus']
    if (!ACTION_TRIGGER_STATUSES.includes(onStatus as ActionTriggerStatus)) problems.add(`${here}.onStatus`, `must be one of: ${ACTION_TRIGGER_STATUSES.join(', ')}`)
    const minutes: number[] = []
    for (const field of ['delayMinutes', 'cooldownMinutes'] as const) {
      const given = item[field] ?? 0
      if (!(typeof given === 'number' && Number.isInteger(given) && given >= 0 && given <= MAX_ACTION_MINUTES)) problems.add(`${here}.${field}`, `must be a whole number of minutes from 0 to ${MAX_ACTION_MINUTES}`)
      minutes.push(typeof given === 'number' ? given : 0)
    }
    if (isValidEntityKey(action) && ACTION_TRIGGER_STATUSES.includes(onStatus as ActionTriggerStatus)) {
      if (seen.has(`${action}:${String(onStatus)}`)) problems.add(here, `an action can be linked once per status ("${action}" twice on ${String(onStatus)})`)
      seen.add(`${action}:${String(onStatus)}`)
      links.push({ action, onStatus: onStatus as ActionTriggerStatus, delayMinutes: minutes[0]!, cooldownMinutes: minutes[1]! })
    }
  })
  return links
}

export const actionKind: ConfigKind<State, ExportState, DesiredAction, PlannedAction[]> = {
  kind: 'Action',

  parse(entry, index, seen, problems) {
    const key = documentKey(entry, `document ${index + 1}`, seen, problems, entityKeys)
    const path = key ? `Action[${key}]` : `document ${index + 1}`
    unknownFields(entry, ACTION_FIELDS, path, problems)

    const name = entry['name']
    if (typeof name !== 'string' || !name.trim()) problems.add(`${path}.name`, 'is required')
    else if (name.length > MAX_NAME_LENGTH) problems.add(`${path}.name`, `must be at most ${MAX_NAME_LENGTH} characters`)
    if (entry['enabled'] !== undefined && typeof entry['enabled'] !== 'boolean') problems.add(`${path}.enabled`, 'must be true or false')
    if (entry['requiresApproval'] !== undefined && typeof entry['requiresApproval'] !== 'boolean') problems.add(`${path}.requiresApproval`, 'must be true or false')
    const timeout = entry['approvalTimeoutMinutes'] ?? DEFAULT_APPROVAL_TIMEOUT_MINUTES
    if (!(typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 1 && timeout <= MAX_ACTION_MINUTES)) problems.add(`${path}.approvalTimeoutMinutes`, `must be a whole number of minutes from 1 to ${MAX_ACTION_MINUTES}`)
    const config = entry['config']
    if (!isObject(config)) problems.add(`${path}.config`, 'is required and must be an object')
    else if (nestedDeeperThan(config, MAX_CONFIG_DEPTH)) problems.add(`${path}.config`, `is nested deeper than ${MAX_CONFIG_DEPTH} levels`)
    // `failureNotifications` is the name this field had up to 0.6; it is still read, but not together with the new one.
    if (entry['notifications'] !== undefined && entry['failureNotifications'] !== undefined) problems.add(path, 'has both notifications and failureNotifications; use notifications')
    const notifications = keysOf(entry['notifications'] !== undefined ? entry['notifications'] : entry['failureNotifications'], `${path}.notifications`, problems)

    if (!key || typeof name !== 'string' || !isObject(config)) return null
    return { path, key, name, config, enabled: entry['enabled'] !== false, requiresApproval: entry['requiresApproval'] === true, approvalTimeoutMinutes: typeof timeout === 'number' ? timeout : DEFAULT_APPROVAL_TIMEOUT_MINUTES, notifications }
  },

  plan(desired, ctx) {
    const { state, token, problems, resolveVaults } = ctx
    const actionByKey = new Map(state.actionRows.map((row) => [row.key, row]))
    const channelKeyById = new Map(state.channelRows.map((row) => [row.id, row.key]))
    const removedChannels = ctx.removed('NotificationChannel')
    const finalChannelKeys = new Set([...state.channelRows.map((row) => row.key).filter((key) => !removedChannels.has(key)), ...(ctx.desired('NotificationChannel') as DesiredChannel[]).map((channel) => channel.key)])
    const currentChannelKeys = (actionId: number) =>
      state.notificationRows.filter((link) => link.actionId === actionId).flatMap((link) => channelKeyById.get(link.channelId) ?? []).sort()
    const mayLink = mayLinkChannels(token)

    const changes: ConfigChange[] = []
    const planned: PlannedAction[] = []
    for (const action of [...desired].sort(byKey)) {
      const existing = actionByKey.get(action.key)
      const stored = existing ? JSON.parse(existing.config) : undefined
      const secrets = restoreSecrets('channel', action.config, stored)
      if ('error' in secrets) { problems.add(`${action.path}.config`, secrets.error); continue }
      const before = problems.list.length
      const config = resolveVaults(secrets.config, `${action.path}.config`) as Json
      const vaultProblem = vaultUseProblem(token, config, stored)
      if (vaultProblem) problems.add(`${action.path}.config`, vaultProblem)
      // A reference that did not resolve still has names, not ids, so the rest of the checks would only repeat the problem.
      if (problems.list.length === before) {
        const problem = actionConfigError(config)
        if (problem) problems.add(`${action.path}.config`, problem)
        else {
          const typeProblem = actionSecretTypeProblem(config, new Map(state.secretRows.map((row) => [row.id, row.type])))
          if (typeProblem) problems.add(`${action.path}.config`, typeProblem)
        }
      }
      for (const key of action.notifications) if (!finalChannelKeys.has(key)) problems.add(`${action.path}.notifications`, missingLink('channel', key, removedChannels))
      const refuseChannels = () => problems.add(`${action.path}.notifications`, 'a token needs the "channels:write" permission to choose which channels are told about the runs of an action')
      if (!existing) {
        if (action.notifications.length && !mayLink) refuseChannels()
        planned.push({ desired: action, config, existing, fields: [] })
        changes.push({ kind: 'Action', key: action.key, action: 'create' })
        continue
      }
      const current: Json = { name: existing.name, enabled: existing.enabled === 1, requiresApproval: existing.requiresApproval === 1, approvalTimeoutMinutes: existing.approvalTimeoutMinutes, config: JSON.parse(existing.config), notifications: currentChannelKeys(existing.id) }
      const wanted: Json = { name: action.name, enabled: action.enabled, requiresApproval: action.requiresApproval, approvalTimeoutMinutes: action.approvalTimeoutMinutes, config, notifications: [...action.notifications].sort() }
      const fields = Object.keys(wanted).filter((field) => canonical(current[field]) !== canonical(wanted[field]))
      if (fields.includes('notifications') && !mayLink) refuseChannels()
      if (fields.length) planned.push({ desired: action, config, existing, fields })
      changes.push({ kind: 'Action', key: action.key, action: fields.length ? 'update' : 'unchanged', ...(fields.length ? { fields } : {}) })
    }
    return { planned, changes }
  },

  existingIds: (state) => new Map(state.actionRows.map((row) => [row.key, row.id])),

  async remove(keys, { state, ids }) {
    const audit: AuditEntry[] = []
    for (const key of keys) {
      const id = ids('Action').get(key)!
      const row = state.actionRows.find((each) => each.id === id)!
      await cancelRunsOfAction(id)
      await db.delete(monitorActions).where(eq(monitorActions.actionId, id))
      await db.delete(actionNotificationChannels).where(eq(actionNotificationChannels.actionId, id))
      await db.delete(actions).where(eq(actions.id, id))
      audit.push({ action: 'delete', entity: 'action', id, name: row.name, diff: { key, source: 'configuration import' } })
    }
    return audit
  },

  async apply(planned, { now, ids }) {
    const audit: AuditEntry[] = []
    const source = 'configuration import'
    const channelId = ids('NotificationChannel')
    for (const { desired: action, config, existing, fields } of planned) {
      const values = { name: action.name, config: JSON.stringify(config), enabled: action.enabled ? 1 : 0, requiresApproval: action.requiresApproval ? 1 : 0, approvalTimeoutMinutes: action.approvalTimeoutMinutes }
      let id: number
      if (existing) {
        id = existing.id
        await db.update(actions).set({ ...values, updatedAt: now }).where(eq(actions.id, id))
        audit.push({ action: 'update', entity: 'action', id, name: existing.name, diff: { key: action.key, source, changed: fields.join(', ') } })
      } else {
        const [row] = await db.insert(actions).values({ key: action.key, ...values, createdAt: now, updatedAt: now }).returning({ id: actions.id })
        id = row!.id
        ids('Action').set(action.key, id)
        audit.push({ action: 'create', entity: 'action', id, name: action.name, diff: { key: action.key, source } })
      }
      if (!existing || fields.includes('notifications')) {
        await db.delete(actionNotificationChannels).where(eq(actionNotificationChannels.actionId, id))
        if (action.notifications.length) {
          await db.insert(actionNotificationChannels).values(action.notifications.map((key) => ({ actionId: id, channelId: channelId.get(key)! })))
        }
      }
    }
    return audit
  },

  export(state, ctx) {
    const channelKey = new Map(state.channelRows.map((row) => [row.id, row.key]))
    const keysOfIds = (ids: number[]) => ids.flatMap((id) => channelKey.get(id) ?? []).sort()
    return ctx.wanted(state.actionRows, 'Action').map((row) => ({
      kind: 'Action' as const,
      key: row.key,
      name: row.name,
      enabled: row.enabled === 1,
      ...(row.requiresApproval === 1 ? { requiresApproval: true } : {}),
      ...(row.approvalTimeoutMinutes !== DEFAULT_APPROVAL_TIMEOUT_MINUTES ? { approvalTimeoutMinutes: row.approvalTimeoutMinutes } : {}),
      config: ctx.exportVaultRefs(maskSecrets('channel', JSON.parse(row.config))) as Json,
      notifications: keysOfIds(state.notificationRows.filter((link) => link.actionId === row.id).map((link) => link.channelId)),
    })).sort(exportByKey)
  },
}
