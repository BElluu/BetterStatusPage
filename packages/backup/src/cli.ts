import path from 'node:path'
import type { BackupService } from './service.js'

function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}

export interface BackupCliOptions {
  service: Pick<BackupService, 'createBackup' | 'validateBackup'>
  /** The application's database handle: opened for the backup and closed after it. */
  database: { open: () => void; close: () => void }
  /** A backup file name as the usage line shows it (`<name>-backup-timestamp.backup`). */
  exampleFile: string
}

/**
 * The command line of `backup`: makes a backup (`--output <dir>` picks where) or, with `--verify <file>` /
 * `--verify --input <file>`, checks one. Prints JSON; failures set a non-zero exit code.
 */
export async function runBackupCli(argv: string[], options: BackupCliOptions): Promise<void> {
  try {
    const verifyMode = argv.includes('--verify')
    const verify = argument(argv, '--input') ?? argument(argv, '--verify')
    if (verifyMode) {
      if (!verify || verify.startsWith('--')) throw new Error(`Usage: backup:verify -- --input <${options.exampleFile}>`)
      const manifest = options.service.validateBackup(path.resolve(verify))
      console.log(JSON.stringify({ valid: true, manifest }, null, 2))
      return
    }
    options.database.open()
    try {
      const output = argument(argv, '--output')
      console.log(JSON.stringify(await options.service.createBackup(output ? path.resolve(output) : undefined), null, 2))
    } finally { options.database.close() }
  } catch (error) { fail(error) }
}

export interface RestoreCliOptions {
  restore: (input: string, extra: string) => Promise<unknown>
  exampleFile: string
  /** The one extra value the restore needs (for example the key the backup was made with). */
  extra: { flag: string; placeholder: string }
}

/** The command line of `restore`: `--input <file>` and the extra flag are both required. */
export async function runRestoreCli(argv: string[], options: RestoreCliOptions): Promise<void> {
  const input = argument(argv, '--input')
  const extra = argument(argv, options.extra.flag)
  if (!input || !extra) {
    console.error(`Usage: restore --input <${options.exampleFile}> ${options.extra.flag} ${options.extra.placeholder}`)
    process.exitCode = 1
    return
  }
  try { console.log(JSON.stringify(await options.restore(path.resolve(input), extra), null, 2)) }
  catch (error) { fail(error) }
}
