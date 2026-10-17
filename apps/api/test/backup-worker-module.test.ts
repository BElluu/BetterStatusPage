import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// The backup worker thread loads this module by URL (`moduleUrl` in kit/backup.ts) and calls these two functions.
// Backups run inline in tests, so nothing else would notice if the module stopped exporting them.
describe('backup worker module', () => {
  it('exports what the worker thread calls', async () => {
    const worker = await import('../src/kit/backupService.js')
    assert.equal(typeof worker.createBackup, 'function')
    assert.equal(typeof worker.validateBackup, 'function')
  })
})
