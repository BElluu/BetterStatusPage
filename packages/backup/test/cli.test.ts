import assert from 'node:assert/strict'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { runBackupCli, runRestoreCli } from '@better-forge/backup'

let output: string[]
let errors: string[]

beforeEach(() => {
  output = []
  errors = []
  mock.method(console, 'log', (line: string) => { output.push(line) })
  mock.method(console, 'error', (line: string) => { errors.push(line) })
  process.exitCode = undefined
})

afterEach(() => {
  mock.restoreAll()
  process.exitCode = undefined
})

function backupOptions() {
  const calls: string[] = []
  return {
    calls,
    options: {
      service: {
        createBackup: async (directory?: string) => { calls.push(`create ${directory ?? '-'}`); return { filename: 'kit-backup-1.backup', size: 1, createdAt: 1 } },
        validateBackup: (input: string) => { calls.push(`validate ${input}`); return { formatVersion: 1, createdAt: 1, appVersion: '1', databaseIntegrity: 'ok' as const } },
      },
      database: { open: () => calls.push('open'), close: () => calls.push('close') },
      exampleFile: 'kit-backup-timestamp.backup',
    },
  }
}

describe('backup command', () => {
  it('makes a backup with the database open, optionally into the directory asked for', async () => {
    const { calls, options } = backupOptions()
    await runBackupCli(['node', 'backup'], options)
    await runBackupCli(['node', 'backup', '--output', 'out'], options)
    assert.deepEqual(calls, ['open', 'create -', 'close', 'open', `create ${path.resolve('out')}`, 'close'])
    assert.equal(JSON.parse(output[0]!).filename, 'kit-backup-1.backup')
    assert.equal(process.exitCode, undefined)
  })

  it('verifies a file named with --input or right after --verify, without opening the database', async () => {
    const { calls, options } = backupOptions()
    await runBackupCli(['node', 'backup', '--verify', '--input', 'a.backup'], options)
    await runBackupCli(['node', 'backup', '--verify', 'b.backup'], options)
    assert.deepEqual(calls, [`validate ${path.resolve('a.backup')}`, `validate ${path.resolve('b.backup')}`])
    assert.equal(JSON.parse(output[0]!).valid, true)
  })

  it('shows the usage and fails when there is nothing to verify', async () => {
    const { calls, options } = backupOptions()
    await runBackupCli(['node', 'backup', '--verify'], options)
    assert.deepEqual(errors, ['Usage: backup:verify -- --input <kit-backup-timestamp.backup>'])
    assert.equal(process.exitCode, 1)
    assert.deepEqual(calls, [])
  })

  it('closes the database and fails when the backup cannot be made', async () => {
    const { calls, options } = backupOptions()
    options.service.createBackup = async () => { throw new Error('disk full') }
    await runBackupCli(['node', 'backup'], options)
    assert.deepEqual(calls, ['open', 'close'])
    assert.deepEqual(errors, ['disk full'])
    assert.equal(process.exitCode, 1)
  })
})

describe('restore command', () => {
  const options = (restore: (input: string, extra: string) => Promise<unknown>) => ({
    restore, exampleFile: 'kit-backup-timestamp.backup', extra: { flag: '--key', placeholder: '<hex>' },
  })

  it('needs both the file and the extra value', async () => {
    await runRestoreCli(['node', 'restore', '--input', 'a.backup'], options(async () => ({})))
    assert.deepEqual(errors, ['Usage: restore --input <kit-backup-timestamp.backup> --key <hex>'])
    assert.equal(process.exitCode, 1)
  })

  it('passes the resolved file and the value on, and prints the result', async () => {
    let seen = ''
    await runRestoreCli(['node', 'restore', '--input', 'a.backup', '--key', 'k'], options(async (input, extra) => { seen = `${input}|${extra}`; return { ok: true } }))
    assert.equal(seen, `${path.resolve('a.backup')}|k`)
    assert.deepEqual(JSON.parse(output[0]!), { ok: true })
    assert.equal(process.exitCode, undefined)
  })

  it('reports a failed restore and exits non-zero', async () => {
    await runRestoreCli(['node', 'restore', '--input', 'a', '--key', 'k'], options(async () => { throw new Error('wrong key') }))
    assert.deepEqual(errors, ['wrong key'])
    assert.equal(process.exitCode, 1)
  })
})
