import type { ChartNode, LayoutNode, LayoutTree } from '@bsp/shared'
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

function collectCharts(nodes: LayoutNode[], into: ChartNode[] = []): ChartNode[] {
  for (const node of nodes) {
    if (node.type === 'chart') into.push(node)
    else if (node.type === 'group') collectCharts(node.children, into)
  }
  return into
}

export const chartRangeKey = (monitorId: number, hours: number, buckets: number): string => `${monitorId}:${hours}:${buckets}`

let loading: Promise<Set<number>> | null = null
let snapshot: Set<number> = new Set()
let chartRanges: Set<string> = new Set()

async function load(): Promise<Set<number>> {
  const row = (await db.select().from(layout))[0]
  let ids = new Set<number>()
  let charts: ChartNode[] = []
  if (row) {
    try {
      const children = (JSON.parse(row.tree) as LayoutTree).children ?? []
      ids = collectPublishedMonitorIds(children)
      charts = collectCharts(children)
    } catch { /* unpublished */ }
  }
  const existing = new Set((await db.select({ id: monitors.id }).from(monitors)).map((monitor) => monitor.id))
  snapshot = new Set([...ids].filter((id) => existing.has(id)))
  chartRanges = new Set(charts.filter((chart) => snapshot.has(chart.monitorId)).map((chart) => chartRangeKey(chart.monitorId, chart.hours, chart.buckets)))
  return snapshot
}

/**
 * The (monitor, hours, buckets) combinations the charts of the page ask for. Any other range is a
 * query nobody on the page needs, so the public history route refuses it.
 */
export async function getPublishedChartRanges(): Promise<ReadonlySet<string>> {
  await getPublishedMonitorIds()
  return chartRanges
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
