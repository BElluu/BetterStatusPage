import { createConfigEngine, type Json } from '@better-kit/config-as-code'
import { withImmediateTransaction } from '../db/transaction.js'
import { writeAudit, type Actor } from './audit.js'
import { refreshPublishedMonitorIds } from '../services/publishedMonitors.js'
import { actionKind } from './config/action.js'
import { channelKind } from './config/channel.js'
import { monitorKind } from './config/monitor.js'
import { loadExportState, loadState, type ExportState, type State } from './config/state.js'

/** What a document describes. A file is a stream of documents, each with a `kind`. */
export const DOCUMENT_KINDS = ['Monitor', 'NotificationChannel', 'Action'] as const
export type DocumentKind = typeof DOCUMENT_KINDS[number]

/** The configuration of this application as documents: monitors, notification channels and actions. */
export const config = createConfigEngine<State, ExportState, Actor>({
  // Messages name the kinds in this order; they are planned, written and exported channels first, monitors last.
  kinds: [monitorKind, channelKind, actionKind],
  order: ['NotificationChannel', 'Action', 'Monitor'],
  loadState,
  loadExportState,
  vaultRows: (state) => ({ vaults: state.vaultRows, secrets: state.secretRows }),
  exportVaultRows: (state) => ({ vaults: state.vaultRows, secrets: state.secretRows }),
  transaction: withImmediateTransaction,
  audit: { write: (actor, action, entity, id, name, diff?: Json) => writeAudit(actor, action, entity, id, name, diff) },
  afterApply: async () => { await refreshPublishedMonitorIds() },
})
