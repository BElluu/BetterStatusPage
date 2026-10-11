import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { incidents, monitorResults, monitors } from '../db/schema.js'

const escapeLabel = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

/** The current state of the instance in the Prometheus text exposition format (version 0.0.4). */
export async function renderMetrics(): Promise<string> {
  const [monitorRows, results, [open]] = await Promise.all([
    db.select({
      id: monitors.id,
      name: monitors.name,
      key: monitors.key,
      type: monitors.type,
      status: monitors.currentStatus,
      lastCheckedAt: monitors.lastCheckedAt,
      certExpiresAt: monitors.certExpiresAt,
    }).from(monitors).orderBy(monitors.id),
    db.select({ monitorId: monitorResults.monitorId, responseMs: monitorResults.responseMs }).from(monitorResults)
      .where(inArray(monitorResults.id, db.select({ id: sql<number>`max(${monitorResults.id})` }).from(monitorResults).groupBy(monitorResults.monitorId))),
    db.select({ count: sql<number>`count(*)` }).from(incidents).where(and(isNull(incidents.resolvedAt), eq(incidents.draft, 0))),
  ])
  const responseById = new Map(results.map((result) => [result.monitorId, result.responseMs]))
  const rows = monitorRows.map((row) => ({ ...row, responseMs: responseById.get(row.id) ?? null }))

  const lines: string[] = []
  const family = (name: string, help: string, samples: Array<[monitor: typeof rows[number], value: number]>) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`)
    for (const [row, value] of samples) {
      lines.push(`${name}{monitor="${escapeLabel(row.name)}",key="${escapeLabel(row.key)}",type="${escapeLabel(row.type)}"} ${value}`)
    }
  }

  family('bsp_monitor_up', '1 when the monitor is up, 0 for any other status; monitors that have not been checked yet are left out.',
    rows.filter((row) => row.status !== 'pending').map((row) => [row, row.status === 'up' ? 1 : 0]))
  family('bsp_monitor_response_time_seconds', 'Response time of the latest check.',
    rows.filter((row) => row.responseMs !== null).map((row) => [row, row.responseMs! / 1000]))
  family('bsp_monitor_last_check_timestamp_seconds', 'Unix time of the latest check.',
    rows.filter((row) => row.lastCheckedAt !== null).map((row) => [row, row.lastCheckedAt! / 1000]))
  family('bsp_monitor_certificate_expiry_timestamp_seconds', 'Unix time the TLS certificate of an HTTPS monitor expires.',
    rows.filter((row) => row.certExpiresAt !== null).map((row) => [row, row.certExpiresAt! / 1000]))
  lines.push('# HELP bsp_incidents_open Published incidents that are not resolved.', '# TYPE bsp_incidents_open gauge', `bsp_incidents_open ${open?.count ?? 0}`)
  return `${lines.join('\n')}\n`
}
