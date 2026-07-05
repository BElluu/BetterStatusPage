import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { pipeline } from 'stream/promises'
import { applyRetention, backupFile, currentVaultKeyMatches, DEFAULT_BACKUP_CONFIG, listBackups, readBackupConfig, readBackupStatus, validateBackup, writeBackupConfig, type BackupConfig } from '../services/backup.js'
import { createBackupInWorker } from '../services/backupRunner.js'
import { writeAudit } from '../services/audit.js'
import { restartBackupScheduler } from '../workers/backupScheduler.js'

function actor(req: { user: unknown }) {
  const user = req.user as { userId: number; email: string }
  return { userId: user.userId, userEmail: user.email }
}

function parseConfig(value: Partial<BackupConfig>): BackupConfig {
  const config = { ...DEFAULT_BACKUP_CONFIG, ...value }
  if (!['daily', 'weekly'].includes(config.frequency)) throw new Error('Invalid frequency')
  if (!Number.isInteger(config.hour) || config.hour < 0 || config.hour > 23) throw new Error('Hour must be between 0 and 23')
  if (!Number.isInteger(config.minute) || config.minute < 0 || config.minute > 59) throw new Error('Minute must be between 0 and 59')
  if (!Number.isInteger(config.weekday) || config.weekday < 0 || config.weekday > 6) throw new Error('Weekday must be between 0 and 6')
  if (!Number.isInteger(config.retention) || config.retention < 1 || config.retention > 365) throw new Error('Retention must be between 1 and 365')
  return config
}

export async function backupRoutes(app: FastifyInstance) {
  app.get('/', async () => ({ backups: listBackups(), config: readBackupConfig(), status: readBackupStatus() }))
  app.post('/', async (req, reply) => {
    try {
      const result = await createBackupInWorker()
      applyRetention(readBackupConfig().retention)
      await writeAudit(actor(req), 'create', 'backup', result.filename, result.filename)
      return result
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }) }
  })
  app.put<{ Body: Partial<BackupConfig> }>('/config', async (req, reply) => {
    try {
      const config = parseConfig(req.body)
      writeBackupConfig(config)
      applyRetention(config.retention)
      restartBackupScheduler()
      await writeAudit(actor(req), 'update', 'backup-config', null, 'Backup schedule', {
        enabled: config.enabled,
        frequency: config.frequency,
        hour: config.hour,
        minute: config.minute,
        weekday: config.weekday,
        retention: config.retention,
      })
      return config
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }) }
  })
  app.get<{ Params: { filename: string } }>('/:filename/download', async (req, reply) => {
    try {
      const file = backupFile(req.params.filename)
      if (!fs.existsSync(file)) return reply.code(404).send({ error: 'Backup not found' })
      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Content-Disposition', `attachment; filename="${path.basename(file)}"`)
      return reply.send(fs.createReadStream(file))
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }) }
  })
  app.delete<{ Params: { filename: string }; Querystring: { confirm?: string } }>('/:filename', async (req, reply) => {
    try {
      if (req.query.confirm !== req.params.filename) return reply.code(400).send({ error: 'Type the exact backup filename to confirm deletion' })
      const file = backupFile(req.params.filename)
      if (!fs.existsSync(file)) return reply.code(404).send({ error: 'Backup not found' })
      fs.rmSync(file)
      await writeAudit(actor(req), 'delete', 'backup', req.params.filename, req.params.filename)
      return reply.code(204).send()
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }) }
  })
  app.post('/validate', async (req, reply) => {
    const data = await req.file({ limits: { fileSize: 2 * 1024 * 1024 * 1024 } })
    if (!data) return reply.code(400).send({ error: 'No backup file' })
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-upload-'))
    const input = path.join(tempDir, 'backup.backup')
    try {
      await pipeline(data.file, fs.createWriteStream(input, { mode: 0o600 }))
      if (data.file.truncated) throw new Error('Backup file exceeds the 2 GB validation limit')
      const manifest = validateBackup(input)
      return { valid: true, manifest, vaultKeyMatches: currentVaultKeyMatches(manifest) }
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }) }
    finally { fs.rmSync(tempDir, { recursive: true, force: true }) }
  })
}
