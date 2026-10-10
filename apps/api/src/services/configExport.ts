import { db } from '../db/client.js'
import {
  layout, monitorDependencies, monitorNotificationChannels, monitors, notificationChannels, vaultSecrets, vaults,
} from '../db/schema.js'
import { parseAlertPolicy } from './alertPolicy.js'
import { maskSecrets } from './secretFields.js'

/** Bumped when the file format changes in a way an older reader would misread. */
export const CONFIG_VERSION = 1

/** A vault secret named instead of numbered, so the file means the same on another installation. */
export interface ConfigVaultRef { vault: string; secret: string; fieldMapping?: Record<string, string> }

export interface ConfigChannel {
  key: string
  name: string
  type: string
  enabled: boolean
  notifyOnRecovery: boolean
  config: Record<string, unknown>
  alertPolicy: unknown
}

export interface ConfigMonitor {
  key: string
  name: string
  type: string
  intervalSecs: number
  timeoutMs: number
  retries: number
  failureThreshold: number
  recoveryThreshold: number
  config: Record<string, unknown>
  tags: Array<{ label: string; color: string }>
  /** Keys of the notification channels this monitor alerts through. */
  notifications: string[]
  /** Keys of the monitors this one depends on. */
  dependsOn: string[]
}

export interface ConfigDocument {
  version: typeof CONFIG_VERSION
  channels: ConfigChannel[]
  monitors: ConfigMonitor[]
  /** The status page tree; monitor and chart nodes name their monitor by `monitorKey` instead of `monitorId`. */
  layout: Record<string, unknown>
}

/** The file would refer to something it cannot name unambiguously, so it could not be read back. */
export class ConfigExportError extends Error {}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)
const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

const deleted = (what: string, id: unknown) => `(deleted ${what} ${String(id)})`

/** Vault and secret names by id, plus which vault names more than one vault answers to. */
async function loadVaultNames() {
  const [vaultRows, secretRows] = await Promise.all([
    db.select({ id: vaults.id, name: vaults.name }).from(vaults),
    db.select({ id: vaultSecrets.id, vaultId: vaultSecrets.vaultId, name: vaultSecrets.name }).from(vaultSecrets),
  ])
  const nameCount = new Map<string, number>()
  for (const vault of vaultRows) nameCount.set(vault.name, (nameCount.get(vault.name) ?? 0) + 1)
  return {
    vaultName: new Map(vaultRows.map((vault) => [vault.id, vault.name])),
    secret: new Map(secretRows.map((secret) => [secret.id, secret])),
    ambiguous: (name: string) => (nameCount.get(name) ?? 0) > 1,
  }
}

type VaultNames = Awaited<ReturnType<typeof loadVaultNames>>

function isVaultRef(value: unknown): value is { vaultId: number; secretId: number; fieldMapping?: unknown } {
  return isObject(value) && typeof value['vaultId'] === 'number' && typeof value['secretId'] === 'number'
}

function exportVaultRef(ref: { vaultId: number; secretId: number; fieldMapping?: unknown }, names: VaultNames): ConfigVaultRef {
  const vault = names.vaultName.get(ref.vaultId)
  const secret = names.secret.get(ref.secretId)
  if (vault !== undefined && names.ambiguous(vault)) {
    throw new ConfigExportError(`More than one vault is named "${vault}", so a reference to it cannot be exported. Rename one of them.`)
  }
  return {
    vault: vault ?? deleted('vault', ref.vaultId),
    secret: secret && secret.vaultId === ref.vaultId ? secret.name : deleted('secret', ref.secretId),
    ...(isObject(ref.fieldMapping) ? { fieldMapping: ref.fieldMapping as Record<string, string> } : {}),
  }
}

/** Replaces every `vault: { vaultId, secretId }` reference in a config with the names of the vault and secret. */
function exportVaultRefs(value: unknown, names: VaultNames): unknown {
  if (Array.isArray(value)) return value.map((item) => exportVaultRefs(item, names))
  if (!isObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, inner]) =>
    [key, key === 'vault' && isVaultRef(inner) ? exportVaultRef(inner, names) : exportVaultRefs(inner, names)]))
}

/** The same tree with `monitorId` replaced by the key of that monitor, in the same place of each node. */
function exportLayout(node: unknown, keyById: Map<number, string>): unknown {
  if (Array.isArray(node)) return node.map((child) => exportLayout(child, keyById))
  if (!isObject(node)) return node
  return Object.fromEntries(Object.entries(node).map(([key, value]) => {
    if (key === 'monitorId' && typeof value === 'number') return ['monitorKey', keyById.get(value) ?? deleted('monitor', value)]
    return [key, key === 'children' ? exportLayout(value, keyById) : value]
  }))
}

const EMPTY_LAYOUT = { id: 'root', type: 'page', children: [] }

/**
 * The monitors, notification channels and status page layout as a document that does not depend on this
 * installation's numeric ids. Secrets are masked exactly as the API masks them, and runtime state (current status,
 * last check, heartbeat token) is left out.
 */
export async function buildConfigDocument(): Promise<ConfigDocument> {
  const [monitorRows, channelRows, dependencyRows, linkRows, layoutRows, names] = await Promise.all([
    db.select().from(monitors),
    db.select().from(notificationChannels),
    db.select().from(monitorDependencies),
    db.select().from(monitorNotificationChannels),
    db.select().from(layout),
    loadVaultNames(),
  ])
  const monitorKey = new Map(monitorRows.map((row) => [row.id, row.key]))
  const channelKey = new Map(channelRows.map((row) => [row.id, row.key]))
  const keysOf = (ids: number[], lookup: Map<number, string>) => ids.flatMap((id) => lookup.get(id) ?? []).sort()

  const exportedChannels: ConfigChannel[] = channelRows.map((row) => ({
    key: row.key,
    name: row.name,
    type: row.type,
    enabled: row.enabled === 1,
    notifyOnRecovery: row.notifyOnRecovery === 1,
    config: exportVaultRefs(maskSecrets('channel', JSON.parse(row.config)), names) as Json,
    alertPolicy: parseAlertPolicy(row.alertPolicy),
  })).sort(byKey)

  const exportedMonitors: ConfigMonitor[] = monitorRows.map((row) => ({
    key: row.key,
    name: row.name,
    type: row.type,
    intervalSecs: row.intervalSecs,
    timeoutMs: row.timeoutMs,
    retries: row.retries,
    failureThreshold: row.failureThreshold,
    recoveryThreshold: row.recoveryThreshold,
    config: exportVaultRefs(maskSecrets('monitor', JSON.parse(row.config)), names) as Json,
    tags: JSON.parse(row.tags ?? '[]'),
    notifications: keysOf(linkRows.filter((link) => link.monitorId === row.id).map((link) => link.channelId), channelKey),
    dependsOn: keysOf(dependencyRows.filter((dependency) => dependency.dependentId === row.id).map((dependency) => dependency.dependsOnId), monitorKey),
  })).sort(byKey)

  return {
    version: CONFIG_VERSION,
    channels: exportedChannels,
    monitors: exportedMonitors,
    layout: exportLayout(layoutRows[0] ? JSON.parse(layoutRows[0].tree) : EMPTY_LAYOUT, monitorKey) as Json,
  }
}
