/**
 * Public, read-only status API (`/api/v1/public/summary.json`, `/api/v1/public/components.json`).
 * Field names are part of a public contract — change them only together with the "Status API"
 * section of docs/subscriptions.md.
 */

export type ApiPageStatus = 'operational' | 'has_issues' | 'under_maintenance'

export type ApiComponentStatus =
  | 'operational'
  | 'under_maintenance'
  | 'degraded_performance'
  | 'partial_outage'
  | 'major_outage'

export type ApiMaintenanceStatus = 'not_started' | 'in_progress'

export interface ApiComponentRef {
  id: number
  name: string
}

export interface ApiActiveIncident {
  id: number
  name: string
  status: 'investigating' | 'identified' | 'monitoring'
  impact: string
  startedAt: string
  updatedAt: string
  url: string
  components: ApiComponentRef[]
}

export interface ApiActiveMaintenance {
  id: number
  name: string
  description: string | null
  status: ApiMaintenanceStatus
  startsAt: string
  endsAt: string
  /** Minutes. */
  duration: number
  url: string
  /** Empty when the window covers every component. */
  components: ApiComponentRef[]
}

export interface ApiSummary {
  page: { name: string; url: string; status: ApiPageStatus }
  activeIncidents: ApiActiveIncident[]
  activeMaintenances: ApiActiveMaintenance[]
}

export interface ApiComponent {
  /** Monitor id for a component, `group:<layout id>` for a group of components. */
  id: number | string
  name: string
  status: ApiComponentStatus
  description: string | null
  isParent: boolean
  children: ApiComponent[]
}

export interface ApiComponents {
  components: ApiComponent[]
}
