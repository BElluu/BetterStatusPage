export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'
export type IncidentImpact = 'minor' | 'major' | 'critical'

export interface IncidentUpdate {
  id: number
  incidentId: number
  body: string
  /** The body in other languages, by locale code; a language without an entry shows `body`. */
  bodyTranslations?: Record<string, string>
  status: IncidentStatus
  postedAt: number
}

export interface Incident {
  id: number
  title: string
  /** The title in other languages, by locale code; a language without an entry shows `title`. */
  titleTranslations?: Record<string, string>
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

/** One language's wording of a template; a missing field falls back to the template's own text. */
export interface IncidentTemplateTranslation {
  title?: string
  body?: string
  resolvedBody?: string
}

/** Placeholders replaced in a template: {{monitor}}, {{duration}}, {{status}}, {{error}}. The text is in the default language. */
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
  /** Wording in the other languages of the status page, by locale code. */
  translations: Record<string, IncidentTemplateTranslation>
  isDefault: boolean
  createdAt: number
  updatedAt: number
}
