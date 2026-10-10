import { db } from '../db/client.js'
import {
  monitorDependencies, monitorNotificationChannels, monitors, notificationChannels, vaultSecrets, vaults,
} from '../db/schema.js'
import { parseAlertPolicy } from './alertPolicy.js'
import { maskSecrets } from './secretFields.js'

/** A vault secret named instead of numbered, so the file means the same on another installation. */
interface ConfigVaultRef { vault: string; secret: string; fieldMapping?: Record<string, string> }

interface ChannelDocument {
  kind: 'NotificationChannel'
  key: string
  name: string
  type: string
  enabled: boolean
  notifyOnRecovery: boolean
  config: Record<string, unknown>
  alertPolicy: unknown
}

interface MonitorDocument {
  kind: 'Monitor'
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

export type ConfigDocument = ChannelDocument | MonitorDocument

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

/**
 * The notification channels and monitors as documents that do not depend on this installation's
 * numeric ids, in a fixed order: channels, then monitors (each sorted by key). Secrets are masked
 * exactly as the API masks them, and runtime state (current status, last check, heartbeat token) is left out.
 */
export async function buildConfigDocuments(only?: { kind: ConfigDocument['kind']; key: string }): Promise<ConfigDocument[]> {
  const [monitorRows, channelRows, dependencyRows, linkRows, names] = await Promise.all([
    db.select().from(monitors),
    db.select().from(notificationChannels),
    db.select().from(monitorDependencies),
    db.select().from(monitorNotificationChannels),
    loadVaultNames(),
  ])
  const monitorKey = new Map(monitorRows.map((row) => [row.id, row.key]))
  const channelKey = new Map(channelRows.map((row) => [row.id, row.key]))
  const keysOf = (ids: number[], lookup: Map<number, string>) => ids.flatMap((id) => lookup.get(id) ?? []).sort()

  // Only the rows asked for are written out, so a vault name that is ambiguous for some other object does not matter.
  const wanted = <T extends { key: string }>(rows: T[], kind: ConfigDocument['kind']) => (only ? rows.filter((row) => only.kind === kind && row.key === only.key) : rows)

  const channelDocuments: ChannelDocument[] = wanted(channelRows, 'NotificationChannel').map((row) => ({
    kind: 'NotificationChannel' as const,
    key: row.key,
    name: row.name,
    type: row.type,
    enabled: row.enabled === 1,
    notifyOnRecovery: row.notifyOnRecovery === 1,
    config: exportVaultRefs(maskSecrets('channel', JSON.parse(row.config)), names) as Json,
    alertPolicy: parseAlertPolicy(row.alertPolicy),
  })).sort(byKey)

  const monitorDocuments: MonitorDocument[] = wanted(monitorRows, 'Monitor').map((row) => ({
    kind: 'Monitor' as const,
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

  return [...channelDocuments, ...monitorDocuments]
}

/** The one document of a kind and key, or undefined when there is none. */
export function pickDocument(documents: ConfigDocument[], kind: ConfigDocument['kind'], key: string | undefined): ConfigDocument | undefined {
  return documents.find((document) => document.kind === kind && document.key === key)
}
