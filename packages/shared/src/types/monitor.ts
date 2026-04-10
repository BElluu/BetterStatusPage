export type MonitorType = 'https' | 'ping' | 'dns' | 'sqlserver'
export type MonitorStatus = 'up' | 'down' | 'degraded' | 'pending'
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
}

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

export type MonitorConfig = HttpsConfig | PingConfig | DnsConfig | SqlServerConfig

export interface Monitor {
  id: number
  name: string
  type: MonitorType
  intervalSecs: number
  timeoutMs: number
  retries: number
  config: MonitorConfig
  currentStatus: MonitorStatus
  lastCheckedAt: number | null
  createdAt: number
  updatedAt: number
}

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
  overallUptimePct: number
}
