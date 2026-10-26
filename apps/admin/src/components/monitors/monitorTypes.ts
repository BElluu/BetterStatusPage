import type { MonitorType } from '@bsp/shared'

export interface MonitorTypeOption {
  value: MonitorType
  label: string
  /** Heading the type is listed under in the type picker. */
  group: string
  /** Material Symbols icon name for the quick-start tiles. */
  icon: string
  /** Short line for the quick-start tiles shown while no monitor exists yet. */
  hint: string
  /** Stored types this entry covers, when it stands for several; defaults to just `value`. */
  types?: MonitorType[]
}

/** Display order of the type switcher in the monitor form. */
export const MONITOR_TYPES: MonitorTypeOption[] = [
  { value: 'https',     label: 'HTTPS',      group: 'Web',            icon: 'language', hint: 'Website or API endpoint' },
  { value: 'tls',       label: 'TLS certificate', group: 'Web',       icon: 'verified_user', hint: 'Certificate of any TLS port: expiry, trust, host name' },
  { value: 'domain',    label: 'Domain expiry',   group: 'Web',       icon: 'travel_explore', hint: 'Registration end date of a domain' },
  { value: 'ping',      label: 'Ping / TCP', group: 'Network',        icon: 'lan',      hint: 'Host or open port' },
  { value: 'dns',       label: 'DNS',        group: 'Network',        icon: 'dns',      hint: 'Record resolution' },
  { value: 'mail',      label: 'Mail server', group: 'Network',       icon: 'mail',     hint: 'SMTP, IMAP or POP3, optionally signing in' },
  { value: 'ssh',       label: 'SSH',        group: 'Network',        icon: 'terminal', hint: 'Server answers on the SSH port' },
  { value: 'sqlserver', label: 'Database',   group: 'Data',           icon: 'database', hint: 'SQL Server, PostgreSQL, MySQL / MariaDB, MongoDB, Oracle', types: ['sqlserver', 'postgresql', 'mysql', 'mongodb', 'oracle'] },
  { value: 'redis',     label: 'Redis',      group: 'Data',           icon: 'memory',   hint: 'PING, with or without AUTH' },
  { value: 'docker',    label: 'Docker',     group: 'Infrastructure', icon: 'deployed_code', hint: 'Container state and health' },
  { value: 'webhook',   label: 'Webhook',    group: 'Inbound',        icon: 'webhook',  hint: 'Your service calls in' },
]

/** The database engines behind the Database type: one config shape and form; port and test query differ. */
export const DATABASE_ENGINES: { value: MonitorType; label: string; defaultPort: number; defaultQuery: string }[] = [
  { value: 'sqlserver',  label: 'SQL Server',      defaultPort: 1433,  defaultQuery: 'SELECT 1' },
  { value: 'postgresql', label: 'PostgreSQL',      defaultPort: 5432,  defaultQuery: 'SELECT 1' },
  { value: 'mysql',      label: 'MySQL / MariaDB', defaultPort: 3306,  defaultQuery: 'SELECT 1' },
  { value: 'mongodb',    label: 'MongoDB',         defaultPort: 27017, defaultQuery: '{"ping":1}' },
  { value: 'oracle',     label: 'Oracle',          defaultPort: 1521,  defaultQuery: 'SELECT 1 FROM DUAL' },
]

export const DATABASE_DEFAULT_PORTS: Partial<Record<MonitorType, number>> =
  Object.fromEntries(DATABASE_ENGINES.map((e) => [e.value, e.defaultPort]))

export const DATABASE_DEFAULT_QUERIES: Partial<Record<MonitorType, string>> =
  Object.fromEntries(DATABASE_ENGINES.map((e) => [e.value, e.defaultQuery]))

export { isDatabaseType } from '@bsp/shared'
