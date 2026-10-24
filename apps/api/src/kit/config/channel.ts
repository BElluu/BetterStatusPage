import { eq } from 'drizzle-orm'
import type { ChannelAlertPolicy } from '@bsp/shared'
import { tokenAllows, type NotificationChannelType } from '@better-kit/contracts'
import { byKey, canonical, clip, documentKey, isObject, nestedDeeperThan, unknownFields, type AuditEntry, type ConfigChange, type ConfigKind, type Json, type Problems } from '@better-kit/config-as-code'
import { CHANNEL_TYPES, channelConfigError } from '@better-kit/notify'
import { db } from '../../db/client.js'
import { actionNotificationChannels, monitorNotificationChannels, notificationChannels } from '../../db/schema.js'
import { normalizeAlertPolicy, parseAlertPolicy } from '../../services/alertPolicy.js'
import { maskSecrets, restoreSecrets } from '../../services/secretFields.js'
import { vaultUseProblem } from '../vaultUse.js'
import type { ExportState, State } from './state.js'
import { entityKeys, exportByKey, MAX_CONFIG_DEPTH, MAX_NAME_LENGTH } from './shared.js'

const CHANNEL_FIELDS = ['kind', 'key', 'name', 'type', 'enabled', 'notifyOnRecovery', 'config', 'alertPolicy']

export interface DesiredChannel {
  path: string
  key: string
  name: string
  type: NotificationChannelType
  enabled: boolean
  notifyOnRecovery: boolean
  config: Json
  alertPolicy: ChannelAlertPolicy
}

type ChannelRow = typeof notificationChannels.$inferSelect
export interface PlannedChannel { desired: DesiredChannel; config: Json; existing: ChannelRow | undefined; fields: string[] }

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

export const channelKind: ConfigKind<State, ExportState, DesiredChannel, PlannedChannel[]> = {
  kind: 'NotificationChannel',

  parse(entry, index, seen, problems) {
    const key = documentKey(entry, `document ${index + 1}`, seen, problems, entityKeys)
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
  },

  plan(desired, { state, token, problems, resolveVaults }) {
    const channelByKey = new Map(state.channelRows.map((row) => [row.key, row]))
    const changes: ConfigChange[] = []
    const planned: PlannedChannel[] = []

    for (const channel of [...desired].sort(byKey)) {
      const existing = channelByKey.get(channel.key)
      const stored = existing && existing.type === channel.type ? JSON.parse(existing.config) : undefined
      const secrets = restoreSecrets('channel', channel.config, stored)
      if ('error' in secrets) { problems.add(`${channel.path}.config`, secrets.error); continue }
      const config = resolveVaults(secrets.config, `${channel.path}.config`) as Json
      const vaultProblem = vaultUseProblem(token, config, stored)
      if (vaultProblem) problems.add(`${channel.path}.config`, vaultProblem)
      const configProblem = channelConfigError(channel.type, config)
      if (configProblem) problems.add(`${channel.path}.config`, configProblem)
      if (!existing) {
        planned.push({ desired: channel, config, existing, fields: [] })
        changes.push({ kind: 'NotificationChannel', key: channel.key, action: 'create' })
        continue
      }
      const current: Json = {
        name: existing.name, type: existing.type, enabled: existing.enabled === 1, notifyOnRecovery: existing.notifyOnRecovery === 1,
        config: JSON.parse(existing.config), alertPolicy: parseAlertPolicy(existing.alertPolicy),
      }
      const wanted: Json = { name: channel.name, type: channel.type, enabled: channel.enabled, notifyOnRecovery: channel.notifyOnRecovery, config, alertPolicy: channel.alertPolicy }
      const fields = Object.keys(wanted).filter((field) => canonical(current[field]) !== canonical(wanted[field]))
      if (fields.length) planned.push({ desired: channel, config, existing, fields })
      changes.push({ kind: 'NotificationChannel', key: channel.key, action: fields.length ? 'update' : 'unchanged', ...(fields.length ? { fields } : {}) })
    }
    return { planned, changes }
  },

  existingIds: (state) => new Map(state.channelRows.map((row) => [row.key, row.id])),

  async remove(keys, { state, ids }) {
    const audit: AuditEntry[] = []
    for (const key of keys) {
      const id = ids('NotificationChannel').get(key)!
      const row = state.channelRows.find((each) => each.id === id)!
      await db.delete(monitorNotificationChannels).where(eq(monitorNotificationChannels.channelId, id))
      await db.delete(actionNotificationChannels).where(eq(actionNotificationChannels.channelId, id))
      await db.delete(notificationChannels).where(eq(notificationChannels.id, id))
      audit.push({ action: 'delete', entity: 'notification_channel', id, name: row.name, diff: { key, type: row.type, source: 'configuration import' } })
    }
    return audit
  },

  async apply(planned, { now, ids }) {
    const audit: AuditEntry[] = []
    const source = 'configuration import'
    for (const { desired: channel, config, existing, fields } of planned) {
      const values = {
        name: channel.name, type: channel.type, config: JSON.stringify(config),
        enabled: channel.enabled ? 1 : 0, notifyOnRecovery: channel.notifyOnRecovery ? 1 : 0, alertPolicy: JSON.stringify(channel.alertPolicy),
      }
      if (existing) {
        await db.update(notificationChannels).set({ ...values, updatedAt: now }).where(eq(notificationChannels.id, existing.id))
        audit.push({ action: 'update', entity: 'notification_channel', id: existing.id, name: existing.name, diff: { key: channel.key, source, changed: fields.join(', ') } })
      } else {
        const [row] = await db.insert(notificationChannels).values({ key: channel.key, ...values, createdAt: now, updatedAt: now }).returning({ id: notificationChannels.id })
        ids('NotificationChannel').set(channel.key, row!.id)
        audit.push({ action: 'create', entity: 'notification_channel', id: row!.id, name: channel.name, diff: { key: channel.key, type: channel.type, source } })
      }
    }
    return audit
  },

  export: (state, ctx) => ctx.wanted(state.channelRows, 'NotificationChannel').map((row) => ({
    kind: 'NotificationChannel' as const,
    key: row.key,
    name: row.name,
    type: row.type,
    enabled: row.enabled === 1,
    notifyOnRecovery: row.notifyOnRecovery === 1,
    config: ctx.exportVaultRefs(maskSecrets('channel', JSON.parse(row.config))) as Json,
    alertPolicy: parseAlertPolicy(row.alertPolicy),
  })).sort(exportByKey),
}

/** Whether a token may choose which channels an object alerts through. */
export const mayLinkChannels = (token: { scopes: readonly string[] } | undefined) => !token || tokenAllows(token.scopes, 'channels:write')
