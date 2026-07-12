import cron from 'node-cron'

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

function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  options: { max?: number } = {},
): number {
  const raw = env[name]
  if (!raw) return defaultValue
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || (options.max !== undefined && value > options.max)) {
    const range = options.max === undefined ? 'a positive integer' : `an integer between 1 and ${options.max}`
    throw new Error(`${name} must be ${range}`)
  }
  return value
}

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
