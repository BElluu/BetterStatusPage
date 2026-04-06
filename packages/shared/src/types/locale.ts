export type TranslationKey =
  | 'status.operational'
  | 'status.outage'
  | 'status.partialOutage'
  | 'status.degraded'
  | 'status.checking'
  | 'status.pending'
  | 'overall.allOperational'
  | 'overall.majorOutage'
  | 'overall.partialOutage'
  | 'overall.partialDegradation'
  | 'overall.incidentsInProgress'
  | 'overall.checking'
  | 'page.hero'
  | 'page.monitoredRealTime'
  | 'page.service'
  | 'page.services'
  | 'page.incident'
  | 'page.incidents'
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

export type AdminTranslationKey =
  | 'nav.dashboard'
  | 'nav.monitors'
  | 'nav.incidents'
  | 'nav.pageBuilder'
  | 'nav.branding'
  | 'nav.users'
  | 'nav.settings'
  | 'nav.localization'
  | 'nav.darkMode'
  | 'nav.lightMode'
  | 'nav.logout'

export interface Locale {
  code: string
  name: string
  isDefault: number
  translations: Partial<Record<TranslationKey, string>>
  adminTranslations: Partial<Record<AdminTranslationKey, string>>
  updatedAt: number
}

export interface LocaleSummary {
  code: string
  name: string
}
