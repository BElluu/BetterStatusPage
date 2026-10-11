import { desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { incidentMonitors, incidents, incidentUpdates } from '../db/schema.js'

/** Condition for incidents visitors may see; drafts are for operators only. */
export const publishedIncident = eq(incidents.draft, 0)

/** Keeps an unpaged admin list below SQLite's bound-parameter limit. */
const ID_CHUNK_SIZE = 500

export type IncidentUpdateRow = Omit<typeof incidentUpdates.$inferSelect, 'bodyTranslations'> & { bodyTranslations: Record<string, string> }

/** A stored `{ locale: text }` map; anything else is treated as no translations. */
export function parseTranslations(stored: string | null | undefined): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(stored || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch { return {} }
}

export interface IncidentDetails {
  /** Newest first. */
  updates: IncidentUpdateRow[]
  monitorIds: number[]
}

/** Timeline and monitor links for many incidents in two queries per 500 ids, keyed by incident id. */
export async function loadIncidentDetails(ids: readonly number[]): Promise<Map<number, IncidentDetails>> {
  const unique = [...new Set(ids)]
  const details = new Map<number, IncidentDetails>(unique.map((id) => [id, { updates: [], monitorIds: [] }]))

  for (let start = 0; start < unique.length; start += ID_CHUNK_SIZE) {
    const chunk = unique.slice(start, start + ID_CHUNK_SIZE)
    const [updates, links] = await Promise.all([
      db.select().from(incidentUpdates).where(inArray(incidentUpdates.incidentId, chunk))
        .orderBy(desc(incidentUpdates.postedAt), desc(incidentUpdates.id)),
      db.select().from(incidentMonitors).where(inArray(incidentMonitors.incidentId, chunk)),
    ])
    for (const update of updates) details.get(update.incidentId)?.updates.push({ ...update, bodyTranslations: parseTranslations(update.bodyTranslations) })
    for (const link of links) details.get(link.incidentId)?.monitorIds.push(link.monitorId)
  }
  return details
}

/** Attaches `updates` and `monitorIds` to each incident, preserving the input order. */
export async function withIncidentDetails<T extends { id: number }>(rows: readonly T[]): Promise<Array<T & IncidentDetails>> {
  const details = await loadIncidentDetails(rows.map((row) => row.id))
  return rows.map((row) => ({
    ...row,
    // Stored as 0/1; the API speaks booleans.
    ...('draft' in row ? { draft: !!row.draft } : {}),
    ...('titleTranslations' in row ? { titleTranslations: parseTranslations(row.titleTranslations as string) } : {}),
    ...(details.get(row.id) ?? { updates: [], monitorIds: [] }),
  }))
}
