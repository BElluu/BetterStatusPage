export type MonitorType = 'https' | 'ping' | 'dns' | 'sqlserver'
export type MonitorStatus = 'up' | 'down' | 'degraded' | 'pending'

export interface HttpsConfig {
  url: string
  method: 'GET' | 'POST' | 'HEAD'
  expectedStatus: number
  keyword?: string
  headers?: Record<string, string>
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
}

export type MonitorConfig = HttpsConfig | PingConfig | DnsConfig | SqlServerConfig

export interface Monitor {
  id: number
  name: string
  type: MonitorType
  intervalSecs: number
  timeoutMs: number
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
