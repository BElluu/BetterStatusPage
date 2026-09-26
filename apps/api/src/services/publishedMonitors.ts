import type { LayoutNode, LayoutTree } from '@bsp/shared'
import { db } from '../db/client.js'
import { layout, monitors } from '../db/schema.js'

/**
 * Monitors placed on the published page — as a status card or a chart — are the only ones the
 * public API may mention. Everything else is internal: its name, id, status and history stay private.
 */
export function collectPublishedMonitorIds(nodes: LayoutNode[], into = new Set<number>()): Set<number> {
  for (const node of nodes) {
    if (node.type === 'monitor' || node.type === 'chart') into.add(node.monitorId)
    else if (node.type === 'group') collectPublishedMonitorIds(node.children, into)
  }
  return into
}

let loading: Promise<Set<number>> | null = null
let snapshot: Set<number> = new Set()

async function load(): Promise<Set<number>> {
  const row = (await db.select().from(layout))[0]
  let ids = new Set<number>()
  if (row) {
    try { ids = collectPublishedMonitorIds((JSON.parse(row.tree) as LayoutTree).children ?? []) } catch { /* unpublished */ }
  }
  const existing = new Set((await db.select({ id: monitors.id }).from(monitors)).map((monitor) => monitor.id))
  snapshot = new Set([...ids].filter((id) => existing.has(id)))
  return snapshot
}

export function getPublishedMonitorIds(): Promise<Set<number>> {
  loading ??= load().catch((error: unknown) => { loading = null; throw error })
  return loading
}

/** Synchronous view for hot paths such as SSE fan-out; call `getPublishedMonitorIds` first to warm it. */
export function publishedMonitorIdsSnapshot(): ReadonlySet<number> {
  return snapshot
}

/** Call after the layout or the set of monitors changes. */
export function refreshPublishedMonitorIds(): Promise<Set<number>> {
  loading = null
  return getPublishedMonitorIds()
}
