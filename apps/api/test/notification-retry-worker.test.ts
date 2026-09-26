import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import cron from 'node-cron'
import { startNotificationRetryWorker, stopNotificationRetryWorker } from '../src/workers/notificationRetryWorker.js'

afterEach(() => stopNotificationRetryWorker())

describe('notification retry worker lifecycle', () => {
  it('schedules the retry and purge jobs once, however often it is started', () => {
    const before = cron.getTasks().size
    startNotificationRetryWorker()
    assert.equal(cron.getTasks().size, before + 2)
    startNotificationRetryWorker()
    assert.equal(cron.getTasks().size, before + 2)
  })

  it('stops both jobs, tolerates repeated stops and can start again', () => {
    const before = cron.getTasks().size
    startNotificationRetryWorker()
    stopNotificationRetryWorker()
    assert.equal(cron.getTasks().size, before)
    stopNotificationRetryWorker()
    assert.equal(cron.getTasks().size, before)

    startNotificationRetryWorker()
    assert.equal(cron.getTasks().size, before + 2)
  })
})
