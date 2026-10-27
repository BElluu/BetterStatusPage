import {
  DATABASE_TLS_MODES, DEFAULT_CERT_WARN_DAYS, DEFAULT_EXPIRY_WARN_DAYS, DEFAULT_LATENCY_ALERT, HEADER_ASSERTION_OPS, JSON_ASSERTION_OPS,
  LATENCY_FACTOR_RANGE, LATENCY_MIN_DELTA_MS_RANGE, LATENCY_SUSTAIN_RANGE, LATENCY_WINDOW_MINUTES_RANGE, MAIL_DEFAULT_PORTS,
  MAIL_PROTOCOLS, MAIL_SECURITY_MODES, MAX_CERT_WARN_DAYS, MAX_DEGRADED_ABOVE_MS, MAX_EXPIRY_WARN_DAYS, MAX_HTTP_ASSERTIONS,
} from '@bsp/shared'
import type {
  DatabaseConfig, DnsConfig, DockerConfig, DomainConfig, HttpsConfig, MailConfig, MonitorType, PingConfig, RedisConfig,
  SshConfig, TlsCertConfig, WebhookConfig,
} from '@bsp/shared'
import { monitorSecretPaths } from '../services/secretFields.js'
import {
  AUTO_INCIDENT_MINUTES_RANGE, INTERVAL_SECS_RANGE, MONITOR_TYPES, RETRIES_RANGE, THRESHOLD_RANGE, TIMEOUT_MS_RANGE,
} from '../services/monitorInput.js'

/**
 * One field of a monitor's config (or a setting every monitor has), as an agent needs to know it. Each claim is kept
 * honest by apps/api/test/monitor-fields.test.ts, which feeds the real validator.
 */
export interface FieldDoc {
  type: string
  /** The check cannot work without it. */
  required: boolean
  /** The API refuses a monitor that lacks it. Some required fields are not checked on save and only fail when the check runs. */
  validated: boolean
  description: string
  /** Allowed values, when the field is a choice. */
  values?: readonly string[]
  /** What the API or the check uses when the field is absent. */
  default?: string | number | boolean
  /** What the admin console starts a new monitor with. Not applied by the API. */
  suggested?: string | number | boolean
  min?: number
  max?: number
  /** A password, token or similar. Never typed in a chat: a person sets it in the admin console. Filled in from the secret table. */
  secret?: true
  /** Where inside an object field the secrets sit (headers.* = every credential header). Filled in from the secret table. */
  secretPaths?: string[]
}

/**
 * Every key of a config interface needs an entry, and an entry for a key the interface does not have is an error, so a
 * field added to or removed from packages/shared/src/types/monitor.ts fails the build until this catalogue follows.
 */
type Fields<Config> = { [Key in keyof Required<Config>]: FieldDoc }
type Extra = Partial<Omit<FieldDoc, 'type' | 'required' | 'validated' | 'description'>>

/** Refused by the API when missing. */
const must = (type: string, description: string, extra: Extra = {}): FieldDoc => ({ type, required: true, validated: true, description, ...extra })
/** Needed for the check to work, but only found out when it runs. */
const needed = (type: string, description: string, extra: Extra = {}): FieldDoc => ({ type, required: true, validated: false, description, ...extra })
const optional = (type: string, description: string, extra: Extra = {}): FieldDoc => ({ type, required: false, validated: false, description, ...extra })

const VAULT = optional('object', 'Reference to a vault secret that replaces the credentials. Needs the vault:use permission, which an agent token should not have: a person sets this in the admin console.')
const SECRET_NOTE = 'A person sets it in the admin console; do not ask for it in the chat.'
const PORT = { min: 1, max: 65_535 }

const SOCKET_TLS = {
  verifyTls: optional('boolean', 'Checks the certificate chain and host name.', { default: true }),
  tlsCa: optional('string', 'PEM certificate(s) of the authority that signed the server certificate; empty uses the CAs bundled with Node.js.'),
}

const https: Fields<HttpsConfig> = {
  url: needed('string', 'The address to request, http:// or https://.'),
  method: optional('string', 'HTTP method. Agents may use only these three.', { values: ['GET', 'POST', 'HEAD'], default: 'GET' }),
  expectedStatus: optional('number', 'The status code that counts as up.', { default: 200 }),
  keyword: optional('string', 'Text that must appear in the response body.'),
  assertions: optional('array', `Up to ${MAX_HTTP_ASSERTIONS} checks on the final response. Header: { type: "header", name, op: ${HEADER_ASSERTION_OPS.join('|')}, value?, onFail?: degraded|down }. JSON: { type: "json", path: "$.queue.length", op: ${JSON_ASSERTION_OPS.join('|')}, value?, onFail? }.`),
  degradedAboveMs: optional('number', 'A response slower than this many milliseconds makes the check Degraded.', { min: 1, max: MAX_DEGRADED_ABOVE_MS }),
  headers: optional('object', 'Request headers as { name: value }. Credential headers (Authorization and similar) are secrets. ' + SECRET_NOTE),
  body: optional('string', 'Request body for POST.'),
  auth: optional('object', 'Sign-in: { type: "none" } (default), or "basic" { basic: { username, password } }, "oauth2" { oauth2: { tokenUrl, clientId, clientSecret, scope? } }, "cas" { cas: { casServerUrl, username, password } }. Passwords and secrets: ' + SECRET_NOTE),
  ignoreTls: optional('boolean', 'Accepts any server certificate (self-signed, expired, wrong host). Disables certificate expiry warnings.', { default: false }),
  certExpiry: optional('object', `Warns before the TLS certificate expires: { enabled: boolean, warnDays: 1 to ${MAX_CERT_WARN_DAYS} }. The console starts at ${DEFAULT_CERT_WARN_DAYS} days.`),
  cacheBuster: optional('boolean', 'Adds a random bsp_cachebuster query parameter to every request so a CDN or proxy cache cannot answer for a backend that is down. GET and HEAD only; not used with CAS. This is the "bypass cache" option.', { default: false }),
}

const ping: Fields<PingConfig> = {
  host: needed('string', 'Host name or IP address.'),
  mode: optional('string', 'tcp connects to a port; icmp sends a ping. Anything but icmp behaves as tcp.', { values: ['tcp', 'icmp'], default: 'tcp' }),
  port: optional('number', 'Port for tcp.', { default: 80, ...PORT }),
}

const dns: Fields<DnsConfig> = {
  hostname: needed('string', 'The name to resolve.'),
  recordType: optional('string', 'Record type. Absent looks up A records.', { values: ['A', 'AAAA', 'MX', 'CNAME', 'TXT'], default: 'A' }),
  expectedValue: optional('string', 'A value the answer must contain.'),
  resolver: optional('string', 'DNS server to ask instead of the system default.'),
}

const database: Fields<DatabaseConfig> = {
  host: needed('string', 'Database host (fields mode; not used with a connection string).'),
  port: needed('number', 'Port: SQL Server 1433, PostgreSQL 5432, MySQL 3306, MongoDB 27017, Oracle 1521.', PORT),
  database: needed('string', 'Database name (Oracle: service name).'),
  user: needed('string', 'User name (fields mode; not used with a connection string).'),
  password: optional('string', 'Password. The monitor can be created without it; ' + SECRET_NOTE),
  query: optional('string', 'SQL statement to run (MongoDB: a JSON command). Without one: SELECT 1 AS result (SQL Server, PostgreSQL, MySQL), {"ping":1} (MongoDB), SELECT 1 FROM DUAL (Oracle).'),
  expectedResult: optional('string', 'Text the first value returned must equal.'),
  mode: optional('string', 'fields uses host/port/credentials; connectionString takes the whole connection string from a vault secret.', { values: ['fields', 'connectionString'], default: 'fields' }),
  tls: optional('string', 'Connection security in fields mode. prefer is what an absent value means (encrypted, certificate not checked, plain if the server has no TLS); the console starts new monitors at verify, which checks the certificate. Prefer verify.', { values: DATABASE_TLS_MODES, default: 'prefer', suggested: 'verify' }),
  tlsCa: optional('string', 'PEM of the authority that signed the server certificate, for tls: verify.'),
  vault: VAULT,
}

const redis: Fields<RedisConfig> = {
  host: must('string', 'Redis host.'),
  port: must('number', 'Port.', { suggested: 6379, ...PORT }),
  tls: optional('boolean', 'Connects over TLS from the first byte.', { default: false }),
  username: optional('string', 'ACL user.'),
  password: optional('string', 'Password. ' + SECRET_NOTE),
  vault: VAULT,
  ...SOCKET_TLS,
}

const mail: Fields<MailConfig> = {
  protocol: must('string', 'Which service to greet.', { values: MAIL_PROTOCOLS }),
  host: must('string', 'Mail server host.'),
  port: must('number', `Port. Usual ones: ${MAIL_PROTOCOLS.map((protocol) => `${protocol} ${MAIL_SECURITY_MODES.map((mode) => MAIL_DEFAULT_PORTS[protocol][mode]).join('/')} (none/starttls/tls)`).join('; ')}.`, PORT),
  security: must('string', 'none, starttls (upgrade after the greeting) or tls (encrypted from the first byte).', { values: MAIL_SECURITY_MODES }),
  username: optional('string', 'Signs in when set, so the check proves the account works.'),
  password: optional('string', 'Password. ' + SECRET_NOTE),
  vault: VAULT,
  ...SOCKET_TLS,
}

const ssh: Fields<SshConfig> = {
  host: must('string', 'SSH host.'),
  port: must('number', 'Port.', { suggested: 22, ...PORT }),
  expectedBanner: optional('string', 'Text the server identification string must contain (up to 255 characters).', { max: 255 }),
}

const tls: Fields<TlsCertConfig> = {
  host: must('string', 'Host to connect to.'),
  port: must('number', 'Port.', { suggested: 443, ...PORT }),
  servername: optional('string', 'Name sent for SNI and matched against the certificate; defaults to host.'),
  warnDays: must('number', 'The check turns Degraded this many days before the certificate expires.', { suggested: DEFAULT_CERT_WARN_DAYS, min: 1, max: MAX_EXPIRY_WARN_DAYS }),
  ...SOCKET_TLS,
}

const domain: Fields<DomainConfig> = {
  domain: must('string', 'Registered domain name, for example example.com.'),
  warnDays: must('number', 'The check turns Degraded this many days before the registration expires.', { suggested: DEFAULT_EXPIRY_WARN_DAYS, min: 1, max: MAX_EXPIRY_WARN_DAYS }),
}

const docker: Fields<DockerConfig> = {
  endpoint: must('string', 'Docker Engine API: unix:///var/run/docker.sock, npipe:////./pipe/docker_engine, or http(s)://host:port. unix:// is not supported on Windows hosts.'),
  container: must('string', 'Container name or ID.'),
}

const webhook: Fields<WebhookConfig> = {}

const DATABASE_NOTE = 'SQL Server, PostgreSQL, MySQL / MariaDB, MongoDB and Oracle share these fields.'

/** The catalogue. The satisfies clause makes a new monitor type a build error until it is described here. */
export const MONITOR_FIELDS = {
  https, ping, dns, redis, mail, ssh, tls, domain, docker, webhook,
  sqlserver: database, postgresql: database, mysql: database, mongodb: database, oracle: database,
} satisfies Record<MonitorType, Record<string, FieldDoc>>

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

const range = ([min, max]: readonly [number, number]) => ({ min, max })

/** Settings every monitor has, whatever its type; they are arguments of monitor_create and monitor_update. */
export const MONITOR_SETTINGS: Record<string, FieldDoc> = {
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

/** The field with the secret flags the secret table gives it (the table is what masks and refuses, so it decides). */
function withSecrets(type: MonitorType, name: string, doc: FieldDoc): FieldDoc {
  const paths = monitorSecretPaths(type).filter((path) => path === name || path.startsWith(`${name}.`))
  if (paths.length === 0) return doc
  return paths.includes(name) ? { ...doc, secret: true } : { ...doc, secretPaths: paths }
}

export function describeMonitorType(type: MonitorType) {
  const fields = MONITOR_FIELDS[type] as Record<string, FieldDoc>
  return {
    type,
    summary: MONITOR_TYPE_SUMMARY[type],
    note: 'required = the check cannot work without it; validated = the API refuses a monitor that lacks it; default = used when absent; suggested = what the admin console starts with.',
    config: Object.entries(fields).map(([name, doc]) => ({ name, ...withSecrets(type, name, doc) })),
    settings: Object.entries(MONITOR_SETTINGS).map(([name, doc]) => ({ name, ...doc })),
  }
}

export { MONITOR_TYPES }
