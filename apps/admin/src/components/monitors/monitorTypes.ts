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
  { value: 'ping',      label: 'Ping / TCP', group: 'Network',        icon: 'lan',      hint: 'Host or open port' },
  { value: 'dns',       label: 'DNS',        group: 'Network',        icon: 'dns',      hint: 'Record resolution' },
  { value: 'sqlserver', label: 'Database',   group: 'Data',           icon: 'database', hint: 'SQL Server, PostgreSQL, MySQL / MariaDB, MongoDB', types: ['sqlserver', 'postgresql', 'mysql', 'mongodb'] },
  { value: 'docker',    label: 'Docker',     group: 'Infrastructure', icon: 'deployed_code', hint: 'Container state and health' },
  { value: 'webhook',   label: 'Webhook',    group: 'Inbound',        icon: 'webhook',  hint: 'Your service calls in' },
]

/** The database engines behind the Database type: one config shape and form; port and test query differ. */
export const DATABASE_ENGINES: { value: MonitorType; label: string; defaultPort: number; defaultQuery: string }[] = [
  { value: 'sqlserver',  label: 'SQL Server',      defaultPort: 1433,  defaultQuery: 'SELECT 1' },
  { value: 'postgresql', label: 'PostgreSQL',      defaultPort: 5432,  defaultQuery: 'SELECT 1' },
  { value: 'mysql',      label: 'MySQL / MariaDB', defaultPort: 3306,  defaultQuery: 'SELECT 1' },
  { value: 'mongodb',    label: 'MongoDB',         defaultPort: 27017, defaultQuery: '{"ping":1}' },
]

export const DATABASE_DEFAULT_PORTS: Partial<Record<MonitorType, number>> =
  Object.fromEntries(DATABASE_ENGINES.map((e) => [e.value, e.defaultPort]))

export const DATABASE_DEFAULT_QUERIES: Partial<Record<MonitorType, string>> =
  Object.fromEntries(DATABASE_ENGINES.map((e) => [e.value, e.defaultQuery]))

export function isDatabaseType(type: MonitorType): boolean {
  return type in DATABASE_DEFAULT_PORTS
}
