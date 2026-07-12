import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getSchedulerConfig } from '../src/config/scheduler.js'

describe('scheduler configuration', () => {
  it('uses production-safe defaults', () => {
    assert.deepEqual(getSchedulerConfig({}), {
      tickCron: '*/10 * * * * *',
      resultPurgeCron: '0 2 * * *',
      resultRetentionDays: 90,
      checkConcurrency: 20,
    })
  })

  it('parses scheduler environment overrides', () => {
    assert.deepEqual(getSchedulerConfig({
      SCHEDULER_TICK_SECONDS: '15',
      MONITOR_RESULT_PURGE_CRON: '30 3 * * *',
      MONITOR_RESULT_RETENTION_DAYS: '120',
      MONITOR_CHECK_CONCURRENCY: '5',
    }), {
      tickCron: '*/15 * * * * *',
      resultPurgeCron: '30 3 * * *',
      resultRetentionDays: 120,
      checkConcurrency: 5,
    })
  })

  it('rejects invalid numeric values', () => {
    assert.throws(() => getSchedulerConfig({ SCHEDULER_TICK_SECONDS: '60' }), /SCHEDULER_TICK_SECONDS/)
    assert.throws(() => getSchedulerConfig({ MONITOR_CHECK_CONCURRENCY: '0' }), /MONITOR_CHECK_CONCURRENCY/)
    assert.throws(() => getSchedulerConfig({ MONITOR_RESULT_RETENTION_DAYS: 'abc' }), /MONITOR_RESULT_RETENTION_DAYS/)
    assert.throws(() => getSchedulerConfig({ MONITOR_RESULT_PURGE_CRON: 'not-a-cron' }), /MONITOR_RESULT_PURGE_CRON/)
  })
})
