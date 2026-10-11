export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'
export type IncidentImpact = 'minor' | 'major' | 'critical'

export interface IncidentUpdate {
  id: number
  incidentId: number
  body: string
  status: IncidentStatus
  postedAt: number
}

export interface Incident {
  id: number
  title: string
  status: IncidentStatus
  impact: IncidentImpact
  startedAt: number
  resolvedAt: number | null
  createdAt: number
  updatedAt: number
  /** A draft is visible to operators only until it is published. */
  draft: boolean
  /** Monitor whose outage opened this incident automatically; null for a manual one. */
  autoMonitorId: number | null
  updates?: IncidentUpdate[]
  monitorIds?: number[]
}

/** Placeholders replaced in a template: {{monitor}}, {{duration}}, {{status}}, {{error}}. */
export interface IncidentTemplate {
  id: number
  name: string
  /** Incident title. */
  title: string
  /** First timeline entry posted when the incident opens. */
  body: string
  /** Timeline entry posted when the incident is resolved automatically. */
  resolvedBody: string
  impact: IncidentImpact
  isDefault: boolean
  createdAt: number
  updatedAt: number
}
