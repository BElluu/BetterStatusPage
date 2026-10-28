import {
  DEFAULT_LATENCY_ALERT, LATENCY_FACTOR_RANGE, LATENCY_MIN_DELTA_MS_RANGE, LATENCY_SUSTAIN_RANGE, LATENCY_WINDOW_MINUTES_RANGE,
} from '@bsp/shared'
import type { MonitorType } from '@bsp/shared'
import { configJsonSchema } from '../services/monitorConfigSchema.js'
import { monitorSecretPaths } from '../services/secretFields.js'
import {
  AUTO_INCIDENT_MINUTES_RANGE, INTERVAL_SECS_RANGE, MONITOR_TYPES, RETRIES_RANGE, THRESHOLD_RANGE, TIMEOUT_MS_RANGE,
} from '../services/monitorInput.js'

const DATABASE_NOTE = 'SQL Server, PostgreSQL, MySQL / MariaDB, MongoDB and Oracle share these fields.'

export const MONITOR_TYPE_SUMMARY: Record<MonitorType, string> = {
  https: 'A URL: status code, keyword, headers, JSON fields, response time, sign-in flows, certificate expiry, cache bypass.',
  ping: 'Whether a host is alive, by TCP connect or ICMP ping.',
  dns: 'Whether a record resolves, optionally to an expected value.',
  sqlserver: `Runs a query against Microsoft SQL Server. ${DATABASE_NOTE}`,
  postgresql: `Runs a query against PostgreSQL. ${DATABASE_NOTE}`,
  mysql: `Runs a query against MySQL or MariaDB. ${DATABASE_NOTE}`,
  mongodb: `Runs a command against MongoDB. ${DATABASE_NOTE}`,
  oracle: `Runs a query against Oracle Database. ${DATABASE_NOTE}`,
  redis: 'PING against Redis, with a password or ACL user.',
  mail: 'Greeting of an SMTP, IMAP or POP3 server, optionally with a sign-in.',
  ssh: 'Reads the identification string of an SSH server.',
  tls: 'Days until a TLS certificate expires.',
  domain: 'Days until a domain registration expires.',
  docker: 'State and healthcheck of a container.',
  webhook: 'Passive heartbeat: a job calls the monitor\'s URL; silence means trouble. The URL is shown only in the admin console.',
}

/** A setting every monitor has, whatever its type. */
export interface SettingDoc {
  type: string
  required: boolean
  description: string
  values?: readonly string[]
  /** What is used when it is absent. */
  default?: string | number | boolean
  min?: number
  max?: number
}

type Extra = Partial<Omit<SettingDoc, 'type' | 'required' | 'description'>>
const must = (type: string, description: string, extra: Extra = {}): SettingDoc => ({ type, required: true, description, ...extra })
const optional = (type: string, description: string, extra: Extra = {}): SettingDoc => ({ type, required: false, description, ...extra })
const range = ([min, max]: readonly [number, number]) => ({ min, max })

/**
 * Settings every monitor has; they are arguments of monitor_create and monitor_update. The ranges are the constants the
 * API validates with, and apps/api/test/monitor-fields.test.ts feeds the real validator to hold the rest.
 */
export const MONITOR_SETTINGS: Record<string, SettingDoc> = {
  name: must('string', 'Display name.'),
  intervalSecs: optional('number', 'Seconds between checks.', { default: 60, ...range(INTERVAL_SECS_RANGE) }),
  timeoutMs: optional('number', 'Milliseconds before a check fails.', { default: 10_000, ...range(TIMEOUT_MS_RANGE) }),
  retries: optional('number', 'Attempts per check.', { default: 1, ...range(RETRIES_RANGE) }),
  failureThreshold: optional('number', 'Consecutive failed checks before an alert. A value outside the range is brought into it. The public page still updates at once.', { default: 1, ...range(THRESHOLD_RANGE) }),
  recoveryThreshold: optional('number', 'Consecutive good checks before a recovery. A value outside the range is brought into it.', { default: 1, ...range(THRESHOLD_RANGE) }),
  tags: optional('array', 'Up to 20 { label, color } tags.'),
  autoIncidentMinutes: optional('number', 'Opens an incident by itself when the monitor stays down this many minutes; null turns it off.', range(AUTO_INCIDENT_MINUTES_RANGE)),
  autoIncidentMode: optional('string', 'draft keeps the automatic incident private until published; published shows it at once (needs incidents:write).', { values: ['draft', 'published'], default: 'draft' }),
  autoIncidentTemplateId: optional('number', 'Incident template for the automatic incident (see list_incident_templates); null uses the default. A template needs incidents:write.'),
  latencyAlertFactor: optional('number', `Slower-than-usual alert: notify when the p95 response time is this many times its own usual p95 of the last 7 days; null turns it off (${DEFAULT_LATENCY_ALERT.factor} when switched on in the console). Not for domain, tls, docker or webhook monitors.`, range(LATENCY_FACTOR_RANGE)),
  latencyAlertWindowMinutes: optional('number', 'Minutes of recent checks the p95 is taken over.', { default: DEFAULT_LATENCY_ALERT.windowMinutes, ...range(LATENCY_WINDOW_MINUTES_RANGE) }),
  latencyAlertMinDeltaMs: optional('number', 'The p95 must also be at least this many ms above the baseline.', { default: DEFAULT_LATENCY_ALERT.minDeltaMs, ...range(LATENCY_MIN_DELTA_MS_RANGE) }),
  latencyAlertSustain: optional('number', 'Consecutive checks that must agree.', { default: DEFAULT_LATENCY_ALERT.sustain, ...range(LATENCY_SUSTAIN_RANGE) }),
}

/** The property with the secret flags the secret table gives it (the table is what masks and refuses, so it decides). */
function withSecrets(type: MonitorType, name: string, property: Record<string, unknown>): Record<string, unknown> {
  const paths = monitorSecretPaths(type).filter((path) => path === name || path.startsWith(`${name}.`))
  if (paths.length === 0) return property
  return paths.includes(name) ? { ...property, secret: true } : { ...property, secretPaths: paths }
}

const READING = [
  'configSchema is JSON Schema.',
  'required = the API refuses a monitor without it.',
  'needed = the check cannot work without it, but the API does not check; give it.',
  'if/else = a condition on required: when `if` matches, `else` does not apply (a database with mode connectionString needs no host).',
  'unchecked = the API accepts any value there, so give the right type: nothing will tell you.',
  'default = used when absent. suggested = what the admin console starts with.',
  'secret / secretPaths = a person sets it in the admin console; never ask for it in the chat.',
].join(' ')

export function describeMonitorType(type: MonitorType) {
  const schema = configJsonSchema(type)
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([name, property]) => [name, withSecrets(type, name, property)]))
  return {
    type,
    summary: MONITOR_TYPE_SUMMARY[type],
    note: READING,
    configSchema: { ...schema, properties },
    settings: Object.entries(MONITOR_SETTINGS).map(([name, doc]) => ({ name, ...doc })),
  }
}

export { MONITOR_TYPES }
