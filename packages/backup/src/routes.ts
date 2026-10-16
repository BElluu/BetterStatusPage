import type { FastifyInstance, FastifyRequest } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Audit } from '@better-kit/audit'
import { DEFAULT_BACKUP_CONFIG, type BackupConfig, type BackupInfo, type BackupManifest, type BackupService } from './service.js'

/** The part of `@fastify/multipart` the upload route uses; the application registers the plugin. */
interface UploadedFile { file: Readable & { truncated?: boolean } }
type FileReader = (options: { limits: { fileSize: number } }) => Promise<UploadedFile | undefined>

export interface BackupRoutesOptions<Manifest extends BackupManifest> {
  service: BackupService<Manifest>
  audit: Audit
  /** The signed-in caller of a request (the routes sit behind the application's own guards). */
  identity: (req: FastifyRequest) => { userId: number; email: string }
  /** Makes a backup (on a worker thread, in the application). */
  createBackup: () => Promise<BackupInfo>
  /** Verifies a backup file (on a worker thread, in the application). */
  validateBackup: (input: string) => Promise<Manifest>
  /** Called after the schedule changed, to apply it. */
  restartScheduler: () => void
  /** Fields added to the answer of a verification, next to the manifest (e.g. whether a key matches). */
  describeManifest?: (manifest: Manifest) => Record<string, unknown>
}

/** Largest backup file the verification accepts. */
const MAX_VALIDATION_BYTES = 2 * 1024 * 1024 * 1024

function parseConfig(value: Partial<BackupConfig>): BackupConfig {
  const config = { ...DEFAULT_BACKUP_CONFIG, ...value }
  if (!['daily', 'weekly'].includes(config.frequency)) throw new Error('Invalid frequency')
  if (!Number.isInteger(config.hour) || config.hour < 0 || config.hour > 23) throw new Error('Hour must be between 0 and 23')
  if (!Number.isInteger(config.minute) || config.minute < 0 || config.minute > 59) throw new Error('Minute must be between 0 and 59')
  if (!Number.isInteger(config.weekday) || config.weekday < 0 || config.weekday > 6) throw new Error('Weekday must be between 0 and 6')
  if (!Number.isInteger(config.retention) || config.retention < 1 || config.retention > 365) throw new Error('Retention must be between 1 and 365')
  return config
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** The admin routes of the backups: list, create, schedule, download, delete and verify an uploaded file. */
export function createBackupRoutes<Manifest extends BackupManifest>(options: BackupRoutesOptions<Manifest>) {
  const { service, audit } = options
  const actor = (req: FastifyRequest) => audit.actor(options.identity(req))

  return async function backupRoutes(app: FastifyInstance) {
    app.get('/', async () => ({ backups: service.listBackups(), config: service.readBackupConfig(), status: service.readBackupStatus() }))

    app.post('/', async (req, reply) => {
      try {
        const result = await options.createBackup()
        service.applyRetention(service.readBackupConfig().retention)
        await audit.write(actor(req), 'create', 'backup', result.filename, result.filename)
        return result
      } catch (error) { return reply.code(409).send({ error: messageOf(error) }) }
    })

    app.put<{ Body: Partial<BackupConfig> }>('/config', async (req, reply) => {
      try {
        const config = parseConfig(req.body)
        service.writeBackupConfig(config)
        service.applyRetention(config.retention)
        options.restartScheduler()
        await audit.write(actor(req), 'update', 'backup-config', null, 'Backup schedule', {
          enabled: config.enabled,
          frequency: config.frequency,
          hour: config.hour,
          minute: config.minute,
          weekday: config.weekday,
          retention: config.retention,
        })
        return config
      } catch (error) { return reply.code(400).send({ error: messageOf(error) }) }
    })

    app.get<{ Params: { filename: string } }>('/:filename/download', async (req, reply) => {
      try {
        const file = service.backupFile(req.params.filename)
        if (!fs.existsSync(file)) return reply.code(404).send({ error: 'Backup not found' })
        reply.header('Content-Type', 'application/octet-stream')
        reply.header('Content-Disposition', `attachment; filename="${path.basename(file)}"`)
        return reply.send(fs.createReadStream(file))
      } catch (error) { return reply.code(400).send({ error: messageOf(error) }) }
    })

    app.delete<{ Params: { filename: string }; Querystring: { confirm?: string } }>('/:filename', async (req, reply) => {
      try {
        if (req.query.confirm !== req.params.filename) return reply.code(400).send({ error: 'Type the exact backup filename to confirm deletion' })
        const file = service.backupFile(req.params.filename)
        if (!fs.existsSync(file)) return reply.code(404).send({ error: 'Backup not found' })
        fs.rmSync(file)
        await audit.write(actor(req), 'delete', 'backup', req.params.filename, req.params.filename)
        return reply.code(204).send()
      } catch (error) { return reply.code(400).send({ error: messageOf(error) }) }
    })

    app.post('/validate', async (req, reply) => {
      const data = await (req as unknown as { file: FileReader }).file({ limits: { fileSize: MAX_VALIDATION_BYTES } })
      if (!data) return reply.code(400).send({ error: 'No backup file' })
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-upload-'))
      const input = path.join(tempDir, 'backup.backup')
      try {
        await pipeline(data.file, fs.createWriteStream(input, { mode: 0o600 }))
        if (data.file.truncated) throw new Error('Backup file exceeds the 2 GB validation limit')
        const manifest = await options.validateBackup(input)
        return { valid: true, manifest, ...options.describeManifest?.(manifest) }
      } catch (error) { return reply.code(400).send({ error: messageOf(error) }) }
      finally { fs.rmSync(tempDir, { recursive: true, force: true }) }
    })
  }
}
