export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'
export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical'

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
  updates?: IncidentUpdate[]
  monitorIds?: number[]
}
