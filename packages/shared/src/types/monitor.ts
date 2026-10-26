import type { VaultRef } from '@better-kit/contracts'
import type { IncidentImpact } from './incident.js'
import type { MaintenanceRecurrence } from './maintenance.js'
export type MonitorType = 'https' | 'ping' | 'dns' | 'sqlserver' | 'postgresql' | 'mysql' | 'mongodb' | 'oracle' | 'redis' | 'mail' | 'ssh' | 'tls' | 'domain' | 'docker' | 'webhook'
export type MonitorStatus = 'up' | 'down' | 'degraded' | 'pending' | 'affected'
export type HttpsAuthType = 'none' | 'basic' | 'oauth2' | 'cas'

export interface BasicAuthConfig {
  username: string
  password: string
  /** If set, username/password are sourced from vault (overrides direct values) */
  vault?: VaultRef
}

export interface OAuth2Config {
  tokenUrl: string
  clientId: string
  clientSecret: string
  scope?: string
  /** If set, clientId/clientSecret are sourced from vault (overrides direct values) */
  vault?: VaultRef
}

export interface CASConfig {
  casServerUrl: string
  username: string
  password: string
  /** If set, username/password are sourced from vault (overrides direct values) */
  vault?: VaultRef
}

export interface HttpsAuth {
  type: HttpsAuthType
  basic?: BasicAuthConfig
  oauth2?: OAuth2Config
  cas?: CASConfig
}

export interface HttpsConfig {
  url: string
  method: 'GET' | 'POST' | 'HEAD'
  expectedStatus: number
  keyword?: string
  /** Checks on the final response (after redirects): its headers and fields of a JSON body. */
  assertions?: HttpAssertion[]
  /** A response slower than this many milliseconds makes the check Degraded. */
  degradedAboveMs?: number
  headers?: Record<string, string>
  body?: string
  auth?: HttpsAuth
  /** Accepts any server certificate (self-signed, expired, wrong host). Off by default; no certificate expiry warnings are sent while it is on. */
  ignoreTls?: boolean
  /** Warns through the monitor's channels before the endpoint's TLS certificate expires. */
  certExpiry?: CertExpiryConfig
  /** Adds a random `bsp_cachebuster` query parameter to the request, so a CDN or proxy cache cannot answer it. GET and HEAD only; not used with CAS. */
  cacheBuster?: boolean
}

export const CACHE_BUSTER_PARAM = 'bsp_cachebuster'

export const HEADER_ASSERTION_OPS = ['exists', 'not-exists', 'equals', 'not-equals', 'contains'] as const
export const JSON_ASSERTION_OPS = ['exists', 'equals', 'not-equals', 'lt', 'gt', 'contains'] as const
export type HeaderAssertionOp = (typeof HEADER_ASSERTION_OPS)[number]
export type JsonAssertionOp = (typeof JSON_ASSERTION_OPS)[number]
/** What a failed assertion turns the check into; Degraded when not given. */
export type AssertionFailureStatus = 'degraded' | 'down'

export type HttpAssertion =
  | { type: 'header'; name: string; op: HeaderAssertionOp; value?: string; onFail?: AssertionFailureStatus }
  | { type: 'json'; path: string; op: JsonAssertionOp; value?: string | number; onFail?: AssertionFailureStatus }

export const MAX_HTTP_ASSERTIONS = 20
export const MAX_DEGRADED_ABOVE_MS = 300_000
/** A JSON body larger than this is not parsed; its JSON assertions fail. */
export const MAX_JSON_ASSERTION_BODY_BYTES = 1024 * 1024

export interface CertExpiryConfig {
  enabled: boolean
  /** The first warning is sent once the certificate expires within this many days. */
  warnDays: number
}

export const DEFAULT_CERT_WARN_DAYS = 14
export const MAX_CERT_WARN_DAYS = 365
/** Follow-up reminders (days before expiry) sent after the first warning, those below warnDays. */
export const CERT_REMINDER_DAYS: readonly number[] = [7, 3, 1]

/** The slower-than-usual alert of a monitor: its settings, as stored on the monitor and as written in a configuration file. */
export interface LatencyAlertSettings {
  /** Times the p95 must exceed the baseline. */
  factor: number
  /** Minutes of recent checks the p95 is taken over. */
  windowMinutes: number
  /** The p95 must also be at least this many ms above the baseline. */
  minDeltaMs: number
  /** Consecutive checks that must agree before an alert or its recovery is sent. */
  sustain: number
}

export const DEFAULT_LATENCY_ALERT: LatencyAlertSettings = { factor: 3, windowMinutes: 30, minDeltaMs: 200, sustain: 3 }
export const LATENCY_FACTOR_RANGE = [1.5, 10] as const
export const LATENCY_WINDOW_MINUTES_RANGE = [10, 240] as const
export const LATENCY_MIN_DELTA_MS_RANGE = [0, 60_000] as const
export const LATENCY_SUSTAIN_RANGE = [1, 20] as const
/** Days of history the baseline p95 is taken from. */
export const LATENCY_BASELINE_DAYS = 7
/**
 * The monitor types whose response time is the time the service took to answer. Left out: a domain or certificate
 * monitor (it times a registry lookup, or a handshake that is not what it watches), Docker (it times the local socket
 * that answers about the container, not the service in it) and webhook (a heartbeat has no response time).
 */
export const LATENCY_ALERT_TYPES: readonly MonitorType[] = ['https', 'ping', 'dns', 'sqlserver', 'postgresql', 'mysql', 'mongodb', 'oracle', 'redis', 'mail', 'ssh']
export const supportsLatencyAlert = (type: string): boolean => (LATENCY_ALERT_TYPES as readonly string[]).includes(type)

export interface PingConfig {
  host: string
  mode: 'tcp' | 'icmp'
  port?: number
}

export interface DnsConfig {
  hostname: string
  recordType: 'A' | 'AAAA' | 'MX' | 'CNAME' | 'TXT'
  expectedValue?: string
  resolver?: string
}

export const DATABASE_MONITOR_TYPES: readonly MonitorType[] = ['sqlserver', 'postgresql', 'mysql', 'mongodb', 'oracle']
export const isDatabaseType = (type: MonitorType): boolean => DATABASE_MONITOR_TYPES.includes(type)

/**
 * How a database monitor in fields mode secures its connection. `prefer` is what monitors did before the
 * setting existed (encrypted, certificate unchecked, plain when the server has no TLS; MongoDB: no TLS).
 * `require` encrypts without a plain fallback, `verify` also checks the certificate and host name.
 */
export const DATABASE_TLS_MODES = ['prefer', 'require', 'verify'] as const
export type DatabaseTlsMode = (typeof DATABASE_TLS_MODES)[number]

/**
 * Shared by every database monitor type; only the default port differs. `query` is a SQL statement,
 * or for MongoDB a JSON command.
 */
export interface DatabaseConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
  query: string
  expectedResult?: string
  /** 'fields' (default) = individual host/port/database/credentials; 'connectionString' = full connection string from vault */
  mode?: 'fields' | 'connectionString'
  /** fields mode only: a connection string carries its own TLS settings. Absent = `prefer`; the form starts new monitors at `verify`. */
  tls?: DatabaseTlsMode
  /** fields mode, `verify`: PEM certificate(s) of the authority that signed the server certificate; empty = the system's trusted CAs. */
  tlsCa?: string
  /** fields mode: overrides user/password from vault. connectionString mode: provides the full connection string */
  vault?: VaultRef
}

export type SqlServerConfig = DatabaseConfig
export type PostgresConfig = DatabaseConfig
export type MySqlConfig = DatabaseConfig
export type MongoConfig = DatabaseConfig
export type OracleConfig = DatabaseConfig

/** TLS settings shared by the monitors that open a socket to a service. */
export interface SocketTlsConfig {
  /** Checks the certificate chain and host name. On unless set to false. */
  verifyTls?: boolean
  /** PEM certificate(s) of the authority that signed the server certificate; empty = the CAs bundled with Node.js. */
  tlsCa?: string
}

export interface RedisConfig extends SocketTlsConfig {
  host: string
  port: number
  /** Connects over TLS from the first byte. */
  tls?: boolean
  username?: string
  password?: string
  /** If set, username/password are sourced from vault (overrides direct values) */
  vault?: VaultRef
}

export const MAIL_PROTOCOLS = ['smtp', 'imap', 'pop3'] as const
export type MailProtocol = (typeof MAIL_PROTOCOLS)[number]
/** `starttls` upgrades a plain connection after the greeting; `tls` is encrypted from the first byte. */
export const MAIL_SECURITY_MODES = ['none', 'starttls', 'tls'] as const
export type MailSecurity = (typeof MAIL_SECURITY_MODES)[number]

export interface MailConfig extends SocketTlsConfig {
  protocol: MailProtocol
  host: string
  port: number
  security: MailSecurity
  /** Signs in when set, so the check proves the account works and not only that the server answers. */
  username?: string
  password?: string
  /** If set, username/password are sourced from vault (overrides direct values) */
  vault?: VaultRef
}

export interface SshConfig {
  host: string
  port: number
  /** The server's identification string must contain this text. */
  expectedBanner?: string
}

export interface TlsCertConfig extends SocketTlsConfig {
  host: string
  port: number
  /** Host name sent for SNI and matched against the certificate; defaults to `host`. */
  servername?: string
  /** The check turns Degraded this many days before the certificate expires. */
  warnDays: number
}

export interface DomainConfig {
  domain: string
  /** The check turns Degraded this many days before the registration expires. */
  warnDays: number
}

export const MAIL_DEFAULT_PORTS: Record<MailProtocol, Record<MailSecurity, number>> = {
  smtp: { none: 25, starttls: 587, tls: 465 },
  imap: { none: 143, starttls: 143, tls: 993 },
  pop3: { none: 110, starttls: 110, tls: 995 },
}
export const DEFAULT_EXPIRY_WARN_DAYS = 30
export const MAX_EXPIRY_WARN_DAYS = 365

export interface DockerConfig {
  /** Docker Engine API: unix:///var/run/docker.sock, npipe:////./pipe/docker_engine, or http(s)://host:port */
  endpoint: string
  /** Container name or ID */
  container: string
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WebhookConfig {}

export type MonitorConfig =
  | HttpsConfig | PingConfig | DnsConfig | DatabaseConfig | RedisConfig | MailConfig | SshConfig | TlsCertConfig | DomainConfig
  | DockerConfig | WebhookConfig

export interface MonitorTag {
  label: string
  color: string
}

export type AutoIncidentMode = 'draft' | 'published'

export interface Monitor {
  id: number
  /** Technical identifier used by the API and config files; unique, set when the monitor is created and never changed. */
  key: string
  name: string
  type: MonitorType
  intervalSecs: number
  timeoutMs: number
  retries: number
  /** Consecutive failed checks required before an alert is sent. 1 = alert immediately. */
  failureThreshold: number
  /** Consecutive successful checks required before a recovery is sent. 1 = notify immediately. */
  recoveryThreshold: number
  /** Minutes a confirmed outage must last before an incident is opened automatically; null = off. */
  autoIncidentMinutes: number | null
  /** Whether the automatic incident is created as a draft (operators only) or published right away. */
  autoIncidentMode: AutoIncidentMode
  /** Template used for the automatic incident; null = the default template. */
  autoIncidentTemplateId: number | null
  /** Times the p95 response time must exceed the baseline to count as slower than usual; null = the alert is off. */
  latencyAlertFactor: number | null
  /** Minutes of recent checks compared with the baseline. */
  latencyAlertWindowMinutes: number
  /** The p95 must also be at least this many ms above the baseline. */
  latencyAlertMinDeltaMs: number
  /** Consecutive checks that must agree before an alert or its recovery is sent. */
  latencyAlertSustain: number
  /** p95 of the previous 7 days as last measured for the alert; null until the alert has run once. */
  latencyBaselineP95: number | null
  /** When the open slower-than-usual alert was confirmed; null while there is none. */
  latencyAlertSince: number | null
  config: MonitorConfig
  currentStatus: MonitorStatus
  lastCheckedAt: number | null
  webhookToken: string | null
  tags: MonitorTag[]
  /** Expiry of the TLS certificate last seen on an HTTPS monitor's endpoint; null when unknown. */
  certExpiresAt: number | null
  certCheckedAt: number | null
  createdAt: number
  updatedAt: number
}

/** A maintenance window that covers a monitor, as the occurrence that is running or comes next. */
export interface MonitorMaintenanceWindow {
  id: number
  name: string
  description: string | null
  startsAt: number
  endsAt: number
  recurrence: MaintenanceRecurrence
  recurrenceDays: number[]
  timezone: string
  recurrenceUntil: number | null
}

/** What is going on around a monitor right now; the admin list and details carry it next to the monitor. */
export interface MonitorActivity {
  /** A maintenance window covering the monitor is running. */
  maintenance: boolean
  /** Running and upcoming windows that cover the monitor, running ones first, then by start. */
  windows: MonitorMaintenanceWindow[]
  /** Impact of the worst open, published incident that names the monitor; null when there is none. */
  incident: IncidentImpact | null
}

export type MonitorWithActivity = Monitor & { activity: MonitorActivity }

export type PublicMonitor = Pick<Monitor, 'id' | 'name' | 'type' | 'currentStatus' | 'lastCheckedAt'>

export interface MonitorResult {
  id: number
  monitorId: number
  status: MonitorStatus
  responseMs: number | null
  checkedAt: number
  errorMessage: string | null
}

export interface UptimeSummary {
  monitorId: number
  days: Array<{
    date: string
    status: MonitorStatus | 'no-data'
    uptimePct: number
    checksTotal: number
    checksUp: number
  }>
  overallUptimePct: number | null
}

/** Statistics of one monitor over a rolling window; `GET /admin/monitors/:id/stats`. */
export interface MonitorStats {
  monitorId: number
  /** Length of the window, in hours, after clamping to the retention period. */
  hours: number
  from: number
  to: number
  /** Days check results are kept; a longer window has no data before that. */
  retentionDays: number
  checksTotal: number
  checksUp: number
  /** Failures not (yet) confirmed by the failure threshold count as up, like on the status page. */
  uptimePct: number | null
  /** Failed checks that were confirmed by the failure threshold. */
  failures: number
  /** Null when no check in the window recorded a response time. */
  response: { avg: number; min: number; max: number; p50: number; p95: number; p99: number } | null
  /**
   * The usual p95 of the monitor, from its previous seven days (the one measured before the alert while one is open).
   * Null while the history is too short or too sparse; the same figure the slower-than-usual alert compares with.
   */
  baselineP95Ms: number | null
  /** Evenly sized buckets from `from` to `to`; null response values mean no timed check in the bucket. */
  buckets: Array<{
    ts: number
    checksTotal: number
    checksUp: number
    avgMs: number | null
    minMs: number | null
    maxMs: number | null
    p95Ms: number | null
    /** Checks of the bucket that were confirmed failures by status. */
    down: number
    degraded: number
  }>
  /**
   * Uptime bars ending now: hourly for a window up to a day, 6-hourly up to a week, else one per UTC day.
   * `ts` is the start of each bar; a bar without checks has `checksTotal` 0.
   */
  uptime: { stepHours: number; bars: Array<{ ts: number; checksTotal: number; checksUp: number; maintenanceChecks: number }> }
  incidents: {
    total: number
    /** Mean time from start to resolution of the resolved incidents; null when none is resolved. */
    mttrMs: number | null
    recent: Array<{ id: number; title: string; status: string; impact: string; startedAt: number; resolvedAt: number | null }>
  }
  recentFailures: Array<{ checkedAt: number; status: MonitorStatus; responseMs: number | null; errorMessage: string | null; unconfirmed: boolean; inMaintenance: boolean }>
}
