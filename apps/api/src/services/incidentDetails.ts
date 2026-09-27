import { desc, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { incidentMonitors, incidentUpdates } from '../db/schema.js'

/** Keeps an unpaged admin list below SQLite's bound-parameter limit. */
const ID_CHUNK_SIZE = 500

export type IncidentUpdateRow = typeof incidentUpdates.$inferSelect

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
    for (const update of updates) details.get(update.incidentId)?.updates.push(update)
    for (const link of links) details.get(link.incidentId)?.monitorIds.push(link.monitorId)
  }
  return details
}

/** Attaches `updates` and `monitorIds` to each incident, preserving the input order. */
export async function withIncidentDetails<T extends { id: number }>(rows: readonly T[]): Promise<Array<T & IncidentDetails>> {
  const details = await loadIncidentDetails(rows.map((row) => row.id))
  return rows.map((row) => ({ ...row, ...(details.get(row.id) ?? { updates: [], monitorIds: [] }) }))
}
