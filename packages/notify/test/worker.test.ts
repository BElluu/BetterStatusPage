import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import cron from 'node-cron'
import { createDeliveryWorker } from '@better-forge/notify'

const engine = { processDue: async () => 0, purgeOldDeliveries: async () => undefined }

afterEach(() => mock.restoreAll())

describe('delivery worker', () => {
  it('schedules one retry task and one purge task, once, and removes them on stop', () => {
    mock.method(console, 'log', () => undefined)
    const worker = createDeliveryWorker({ engine })
    const before = cron.getTasks().size
    worker.start()
    assert.equal(cron.getTasks().size, before + 2)
    worker.start()
    assert.equal(cron.getTasks().size, before + 2)
    worker.stop()
    assert.equal(cron.getTasks().size, before)
    worker.stop()
    worker.start()
    assert.equal(cron.getTasks().size, before + 2)
    worker.stop()
  })

  it('runs the tasks of the application on the same ticks, logging a failure under its own line', async () => {
    mock.method(console, 'log', () => undefined)
    const errors = mock.method(console, 'error', () => undefined)
    const ticks: Array<() => void> = []
    mock.method(cron, 'schedule', (expression: string, run: () => void) => { ticks.push(run); return { destroy: () => undefined } })
    const ran: string[] = []
    const worker = createDeliveryWorker({
      engine: { processDue: async () => { ran.push('due'); return 0 }, purgeOldDeliveries: async () => { ran.push('purge') } },
      retryTasks: [{ failure: 'extra failed:', run: async () => { throw new Error('boom') } }],
      purgeTasks: [{ failure: 'extra purge failed:', run: async () => { ran.push('extra purge') } }],
    })
    worker.start()
    ticks[0]!()
    ticks[1]!()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(ran, ['due', 'purge', 'extra purge'])
    assert.equal(errors.mock.callCount(), 1)
    assert.equal(errors.mock.calls[0]!.arguments[0], 'extra failed:')
  })
})
