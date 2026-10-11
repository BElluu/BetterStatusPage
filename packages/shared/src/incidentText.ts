import type { Incident, IncidentUpdate } from './types/incident.js'

/** The incident's title in `locale`, or its own text when there is no translation. */
export function incidentTitle(incident: Pick<Incident, 'title' | 'titleTranslations'>, locale: string): string {
  return incident.titleTranslations?.[locale] || incident.title
}

/** The update's body in `locale`, or its own text when there is no translation. */
export function incidentUpdateBody(update: Pick<IncidentUpdate, 'body' | 'bodyTranslations'>, locale: string): string {
  return update.bodyTranslations?.[locale] || update.body
}
