import cron from 'node-cron'
import { readPositiveInteger } from './env.js'

export interface SchedulerConfig {
  tickCron: string
  resultPurgeCron: string
  resultRetentionDays: number
  checkConcurrency: number
}

const DEFAULT_TICK_SECONDS = 10
const DEFAULT_PURGE_CRON = '0 2 * * *'
const DEFAULT_RETENTION_DAYS = 90
const DEFAULT_CHECK_CONCURRENCY = 20

export function getSchedulerConfig(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  const tickSeconds = readPositiveInteger(env, 'SCHEDULER_TICK_SECONDS', DEFAULT_TICK_SECONDS, { max: 59 })
  const resultPurgeCron = env['MONITOR_RESULT_PURGE_CRON']?.trim() || DEFAULT_PURGE_CRON
  if (!cron.validate(resultPurgeCron)) throw new Error('MONITOR_RESULT_PURGE_CRON must be a valid cron expression')

  return {
    tickCron: `*/${tickSeconds} * * * * *`,
    resultPurgeCron,
    resultRetentionDays: readPositiveInteger(env, 'MONITOR_RESULT_RETENTION_DAYS', DEFAULT_RETENTION_DAYS),
    checkConcurrency: readPositiveInteger(env, 'MONITOR_CHECK_CONCURRENCY', DEFAULT_CHECK_CONCURRENCY),
  }
}
