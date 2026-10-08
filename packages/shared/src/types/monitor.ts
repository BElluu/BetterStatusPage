export type MonitorType = 'https' | 'ping' | 'dns' | 'sqlserver' | 'docker' | 'webhook'
export type MonitorStatus = 'up' | 'down' | 'degraded' | 'pending' | 'affected'
export type HttpsAuthType = 'none' | 'basic' | 'oauth2' | 'cas'

/** Reference to a vault secret, with optional field mapping for json-type secrets */
export interface VaultRef {
  vaultId: number
  secretId: number
  /** Only for json-type secrets: maps our field names to JSON object keys */
  fieldMapping?: Record<string, string>
}

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
  headers?: Record<string, string>
  body?: string
  auth?: HttpsAuth
  /** Warns through the monitor's channels before the endpoint's TLS certificate expires. */
  certExpiry?: CertExpiryConfig
}

export interface CertExpiryConfig {
  enabled: boolean
  /** The first warning is sent once the certificate expires within this many days. */
  warnDays: number
}

export const DEFAULT_CERT_WARN_DAYS = 14
export const MAX_CERT_WARN_DAYS = 365
/** Follow-up reminders (days before expiry) sent after the first warning, those below warnDays. */
export const CERT_REMINDER_DAYS: readonly number[] = [7, 3, 1]

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

export interface SqlServerConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
  query: string
  expectedResult?: string
  /** 'fields' (default) = individual host/port/database/credentials; 'connectionString' = full connection string from vault */
  mode?: 'fields' | 'connectionString'
  /** fields mode: overrides user/password from vault. connectionString mode: provides the full connection string */
  vault?: VaultRef
}

export interface DockerConfig {
  /** Docker Engine API: unix:///var/run/docker.sock, npipe:////./pipe/docker_engine, or http(s)://host:port */
  endpoint: string
  /** Container name or ID */
  container: string
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WebhookConfig {}

export type MonitorConfig = HttpsConfig | PingConfig | DnsConfig | SqlServerConfig | DockerConfig | WebhookConfig

export interface MonitorTag {
  label: string
  color: string
}

export interface Monitor {
  id: number
  name: string
  type: MonitorType
  intervalSecs: number
  timeoutMs: number
  retries: number
  /** Consecutive failed checks required before an alert is sent. 1 = alert immediately. */
  failureThreshold: number
  /** Consecutive successful checks required before a recovery is sent. 1 = notify immediately. */
  recoveryThreshold: number
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
