import type { MonitorType } from '@bsp/shared'

export interface MonitorTypeOption {
  value: MonitorType
  label: string
  /** Material Symbols icon name for the quick-start tiles. */
  icon: string
  /** Short line for the quick-start tiles shown while no monitor exists yet. */
  hint: string
}

/** Display order of the type switcher in the monitor form. */
export const MONITOR_TYPES: MonitorTypeOption[] = [
  { value: 'https',     label: 'HTTPS',      icon: 'language', hint: 'Website or API endpoint' },
  { value: 'ping',      label: 'Ping / TCP', icon: 'lan',      hint: 'Host or open port' },
  { value: 'dns',       label: 'DNS',        icon: 'dns',      hint: 'Record resolution' },
  { value: 'sqlserver', label: 'SQL Server', icon: 'database', hint: 'Query a database' },
  { value: 'docker',    label: 'Docker',     icon: 'deployed_code', hint: 'Container state and health' },
  { value: 'webhook',   label: 'Webhook',    icon: 'webhook',  hint: 'Your service calls in' },
]
