import type { DatabaseSync } from 'node:sqlite'
import { sealedText } from '@better-forge/vault'
import { sealer } from '../kit/sealer.js'
import { configCodec } from './secretFields.js'

/**
 * The columns that hold credentials inline. The secrets named in ./secretFields.ts are encrypted when a row is written
 * and opened when it is read, so a copy of the database or of a backup does not carry them. Values read from a vault
 * are references and stay as they are.
 */
const monitorConfig = configCodec('monitor', sealer)
/** Actions take the channel's secret fields: both keep credentials in `headers`. */
const channelConfig = configCodec('channel', sealer)

export const monitorConfigColumn = sealedText(monitorConfig)
export const actionConfigColumn = sealedText(channelConfig)

export const notifySealedColumns = {
  channelConfig: sealedText(channelConfig),
  smtpPassword: sealedText(sealer),
}

/** Encrypts what the sealed columns still hold in the clear, from before they were sealed. Rows already sealed are left alone. */
export function sealStoredSecrets(sqlite: DatabaseSync): void {
  const plain = { seal: sealer.sealPlain, open: sealer.open }
  const jobs = [
    { table: 'monitors', column: 'config', seal: configCodec('monitor', plain).seal },
    { table: 'actions', column: 'config', seal: configCodec('channel', plain).seal },
    { table: 'notification_channels', column: 'config', seal: configCodec('channel', plain).seal },
    { table: 'smtp_settings', column: 'password', seal: plain.seal },
  ]
  const pending = jobs.map((job) => {
    const rows = sqlite.prepare(`SELECT id, ${job.column} AS value FROM ${job.table}`).all() as { id: number; value: string }[]
    return { ...job, changes: rows.map((row) => ({ id: row.id, value: job.seal(row.value) })).filter((change, i) => change.value !== rows[i]!.value) }
  })
  // Without the key the box falls back to a public one, and secrets sealed with it could never be read again with the real key.
  // An unset NODE_ENV is development (that is what `npm run dev` runs with, and what the box warns about).
  if (pending.some((job) => job.changes.length) && !process.env['VAULT_ENCRYPTION_KEY'] && !['test', 'development'].includes(process.env['NODE_ENV'] ?? 'development')) {
    throw new Error('VAULT_ENCRYPTION_KEY must be set to encrypt the stored credentials; set it to the key of this installation and start again')
  }
  for (const job of pending) {
    const update = sqlite.prepare(`UPDATE ${job.table} SET ${job.column} = ? WHERE id = ?`)
    for (const change of job.changes) update.run(change.value, change.id)
  }
}
