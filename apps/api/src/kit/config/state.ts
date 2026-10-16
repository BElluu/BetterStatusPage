import { db } from '../../db/client.js'
import {
  actionFailureChannels, actions, incidentTemplates, monitorActions, monitorDependencies, monitorNotificationChannels, monitors, notificationChannels, vaultSecrets, vaults,
} from '../../db/schema.js'

/** What an import compares a file with: everything the three kinds of document describe, and the vaults they may name. */
export async function loadState() {
  const [monitorRows, channelRows, linkRows, dependencyRows, vaultRows, secretRows, templateRows, actionRows, actionLinkRows, failureRows] = await Promise.all([
    db.select().from(monitors),
    db.select().from(notificationChannels),
    db.select().from(monitorNotificationChannels),
    db.select().from(monitorDependencies),
    db.select({ id: vaults.id, name: vaults.name }).from(vaults),
    db.select({ id: vaultSecrets.id, vaultId: vaultSecrets.vaultId, name: vaultSecrets.name, type: vaultSecrets.type }).from(vaultSecrets),
    db.select({ id: incidentTemplates.id, name: incidentTemplates.name, isDefault: incidentTemplates.isDefault }).from(incidentTemplates),
    db.select().from(actions),
    db.select().from(monitorActions),
    db.select().from(actionFailureChannels),
  ])
  return { monitorRows, channelRows, linkRows, dependencyRows, vaultRows, secretRows, templateRows, actionRows, actionLinkRows, failureRows }
}

export type State = Awaited<ReturnType<typeof loadState>>

/** What an export writes out. Actions are read only for a reader who may see them. */
export async function loadExportState(included: ReadonlySet<string>) {
  const includeActions = included.has('Action')
  const [monitorRows, channelRows, dependencyRows, linkRows, templateRows, vaultRows, secretRows, actionRows, actionLinkRows, failureRows] = await Promise.all([
    db.select().from(monitors),
    db.select().from(notificationChannels),
    db.select().from(monitorDependencies),
    db.select().from(monitorNotificationChannels),
    db.select({ id: incidentTemplates.id, name: incidentTemplates.name }).from(incidentTemplates),
    db.select({ id: vaults.id, name: vaults.name }).from(vaults),
    db.select({ id: vaultSecrets.id, vaultId: vaultSecrets.vaultId, name: vaultSecrets.name }).from(vaultSecrets),
    includeActions ? db.select().from(actions) : Promise.resolve([]),
    includeActions ? db.select().from(monitorActions) : Promise.resolve([]),
    includeActions ? db.select().from(actionFailureChannels) : Promise.resolve([]),
  ])
  return { monitorRows, channelRows, dependencyRows, linkRows, templateRows, vaultRows, secretRows, actionRows, actionLinkRows, failureRows }
}

export type ExportState = Awaited<ReturnType<typeof loadExportState>>
