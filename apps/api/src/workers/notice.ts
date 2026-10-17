import type { DeliveryRow, Notice, NoticeFact, NoticeSegment, NoticeSeverity } from '@better-kit/notify'

type Vars = Record<string, string>

const UNKNOWN_MONITOR = 'Unknown monitor'

function severityOf(status: string): NoticeSeverity {
  if (status === 'up' || status === 'cert-renewed') return 'ok'
  if (status === 'degraded' || status === 'cert-expiring') return 'warning'
  return 'critical'
}

/** The facts of an action failure, which the channels show in place of status and previous status. */
function actionFacts(vars: Vars): NoticeFact[] {
  return [
    { label: 'Action', value: vars['action_name'] ?? 'unknown' },
    { label: 'Monitor', value: vars['monitor_name'] ?? UNKNOWN_MONITOR },
    { label: 'Triggered when', value: vars['trigger_status'] === 'up' ? 'monitor was back up' : 'monitor was down' },
    { label: 'Attempts', value: vars['attempts'] ?? '' },
  ]
}

function headline(vars: Vars, status: string): NoticeSegment[] {
  const name = { subject: vars['monitor_name'] ?? UNKNOWN_MONITOR }
  if (vars['event_type'] === 'action') {
    return ['Action ', { subject: vars['action_name'] ?? 'unknown' }, ' failed for monitor ', name]
  }
  if (vars['event_type'] === 'certificate') {
    if (status === 'cert-renewed') return ['TLS certificate of ', name, ' was renewed']
    // A digest has no single expiry to quote.
    return vars['cert_expires_in']
      ? ['TLS certificate of ', name, ` expires ${vars['cert_expires_in']}`]
      : ['TLS certificates expiring: ', name]
  }
  return [{ kind: 'Monitor ' }, name, ' is ', { state: status.toUpperCase() }]
}

/** What the notification channels say about one event, read from the variables the event was raised with. */
export function noticeFromVars(vars: Vars): Notice {
  const status = vars['status'] ?? 'unknown'
  const isAction = vars['event_type'] === 'action'
  const errorMessage = vars['error_message']
  return {
    severity: severityOf(status),
    headline: headline(vars, status),
    subtitle: isAction
      ? ['Action failed after its last attempt']
      : ['Previously: ', { state: vars['previous_status'] ?? 'unknown' }],
    facts: isAction ? actionFacts(vars) : [
      { label: 'Status', value: status },
      { label: 'Previous', value: vars['previous_status'] ?? 'unknown', fullLabel: 'Previous status' },
      { label: 'Type', value: vars['monitor_type'] ?? 'unknown', fullLabel: 'Monitor type' },
    ],
    // A certificate event carries details, not an error.
    ...(errorMessage ? { detail: { label: vars['event_type'] === 'certificate' ? 'Details' : 'Error', value: errorMessage } } : {}),
    at: vars['checked_at'] ?? 'unknown',
    atLabel: 'Checked at',
  }
}

function worstStatus(rows: DeliveryRow[]): string {
  if (rows.some((row) => row.targetStatus === 'down')) return 'down'
  if (rows.some((row) => row.targetStatus === 'degraded')) return 'degraded'
  return rows[0]?.targetStatus ?? 'unknown'
}

function readVars(row: DeliveryRow): Vars {
  try {
    return JSON.parse(row.variables) as Vars
  } catch {
    return {}
  }
}

/** Builds the notification that stands in for several single-monitor events. */
export function digestOf(rows: DeliveryRow[], now: number): { vars: Vars; sourceName: string } {
  const names = rows.map((row) => row.sourceName)
  const previous = new Set(rows.map((row) => row.previousStatus))
  const lines = rows.map((row) => {
    const detail = readVars(row)['error_message']
    return detail ? `${row.sourceName} → ${row.targetStatus}: ${detail}` : `${row.sourceName} → ${row.targetStatus}`
  })
  const sourceName = `${rows.length} monitors`
  return {
    sourceName,
    vars: {
      monitor_name: sourceName,
      monitor_type: 'group',
      status: worstStatus(rows),
      previous_status: previous.size === 1 ? [...previous][0]! : 'various',
      error_message: lines.join('\n'),
      checked_at: new Date(now).toISOString(),
      event_type: rows[0]?.eventType ?? 'alert',
      monitor_list: names.join(', '),
      affected_count: String(rows.length),
    },
  }
}
