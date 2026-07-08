export type TranslationKey =
  | 'status.operational'
  | 'status.outage'
  | 'status.partialOutage'
  | 'status.degraded'
  | 'status.checking'
  | 'status.pending'
  | 'status.affected'
  | 'status.affectedBy'
  | 'overall.allOperational'
  | 'overall.majorOutage'
  | 'overall.partialOutage'
  | 'overall.partialDegradation'
  | 'overall.incidentsInProgress'
  | 'overall.checking'
  | 'page.hero'
  | 'page.monitoredLine'
  | 'page.incidentLine'
  | 'page.groupServiceCount'
  | 'page.notConfigured'
  | 'page.notConfiguredHint'
  | 'section.systemEvents'
  | 'tab.active'
  | 'tab.history'
  | 'empty.noActiveIncidents'
  | 'empty.noHistory'
  | 'empty.noIncidents'
  | 'uptime.daysAgo'
  | 'uptime.today'
  | 'uptime.noData'
  | 'uptime.pct'
  | 'uptime.resolvedIn'
  | 'uptime.ongoing'
  | 'uptime.affected'
  | 'uptime.noIncidents'
  | 'incident.investigating'
  | 'incident.identified'
  | 'incident.monitoring'
  | 'incident.resolved'

export interface Locale {
  code: string
  name: string
  isDefault: number
  translations: Partial<Record<TranslationKey, string>>
  updatedAt: number
}

export interface LocaleSummary {
  code: string
  name: string
  isDefault?: number
}
