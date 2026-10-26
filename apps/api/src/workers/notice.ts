import type { DeliveryRow, Notice, NoticeFact, NoticeSegment } from '@better-kit/notify'

type Vars = Record<string, string>

const UNKNOWN_MONITOR = 'Unknown monitor'

/** The facts every monitor event shows: its status, the one before it and what kind of monitor it is. */
function monitorFacts(vars: Vars): NoticeFact[] {
  return [
    { label: 'Status', value: vars['status'] ?? 'unknown' },
    { label: 'Previous', value: vars['previous_status'] ?? 'unknown', fullLabel: 'Previous status' },
    { label: 'Type', value: vars['monitor_type'] ?? 'unknown', fullLabel: 'Monitor type' },
  ]
}

const previousStatus = (vars: Vars): NoticeSegment[] => ['Previously: ', { state: vars['previous_status'] ?? 'unknown' }]

const errorDetail = (vars: Vars, label: string) => vars['error_message'] ? { detail: { label, value: vars['error_message'] } } : {}

/** A monitor changed status (also the test message, and a digest of several monitors). */
function alertNotice(vars: Vars): Notice {
  const status = vars['status'] ?? 'unknown'
  return {
    severity: status === 'up' ? 'ok' : status === 'degraded' ? 'warning' : 'critical',
    headline: [{ kind: 'Monitor ' }, { subject: vars['monitor_name'] ?? UNKNOWN_MONITOR }, ' is ', { state: status.toUpperCase() }],
    subtitle: previousStatus(vars),
    facts: monitorFacts(vars),
    ...errorDetail(vars, 'Error'),
    at: vars['checked_at'] ?? 'unknown',
    atLabel: 'Checked at',
  }
}

/** A monitor's TLS certificate is about to expire, or was renewed; the text of the event is its details, not an error. */
function certificateNotice(vars: Vars): Notice {
  const status = vars['status'] ?? 'unknown'
  const name = { subject: vars['monitor_name'] ?? UNKNOWN_MONITOR }
  const renewed = status === 'cert-renewed'
  return {
    severity: renewed ? 'ok' : 'warning',
    headline: renewed
      ? ['TLS certificate of ', name, ' was renewed']
      // A digest has no single expiry to quote.
      : vars['cert_expires_in'] ? ['TLS certificate of ', name, ` expires ${vars['cert_expires_in']}`] : ['TLS certificates expiring: ', name],
    subtitle: previousStatus(vars),
    facts: monitorFacts(vars),
    ...errorDetail(vars, 'Details'),
    at: vars['checked_at'] ?? 'unknown',
    atLabel: 'Checked at',
  }
}

/** A monitor's responses became slower than usual, or are back to normal; the monitor's own status is not part of it. */
function latencyNotice(vars: Vars): Notice {
  const normal = vars['status'] === 'latency-normal'
  const name = { subject: vars['monitor_name'] ?? UNKNOWN_MONITOR }
  return {
    severity: normal ? 'ok' : 'warning',
    // A digest has no single ratio to quote.
    headline: normal
      ? vars['monitor_type'] === 'group' ? ['Back to normal speed: ', name] : [name, ' is back to normal speed']
      : vars['latency_ratio'] ? [name, ` is ${vars['latency_ratio']}× slower than usual`] : ['Slower than usual: ', name],
    subtitle: previousStatus(vars),
    facts: [
      ...(vars['latency_p95_ms'] ? [{ label: 'p95', value: `${vars['latency_p95_ms']} ms`, fullLabel: 'p95 response time' }] : []),
      ...(vars['latency_baseline_ms'] ? [{ label: 'Baseline', value: `${vars['latency_baseline_ms']} ms`, fullLabel: 'Baseline p95 (7 days)' }] : []),
      ...monitorFacts(vars),
    ],
    ...errorDetail(vars, 'Details'),
    at: vars['checked_at'] ?? 'unknown',
    atLabel: 'Checked at',
  }
}

/** An action ran for a monitor, failed after its last attempt, or waits for approval. It has no status of its own to show, so it lists what ran. */
function actionNotice(vars: Vars): Notice {
  const succeeded = vars['status'] === 'action-succeeded'
  const awaiting = vars['status'] === 'action-approval'
  return {
    severity: succeeded ? 'ok' : awaiting ? 'warning' : 'critical',
    headline: ['Action ', { subject: vars['action_name'] ?? 'unknown' }, succeeded ? ' ran for monitor ' : awaiting ? ' needs approval for monitor ' : ' failed for monitor ', { subject: vars['monitor_name'] ?? UNKNOWN_MONITOR }],
    subtitle: [succeeded ? 'Action ran successfully' : awaiting ? 'Waiting for an admin to approve it in the panel' : 'Action failed after its last attempt'],
    facts: [
      { label: 'Action', value: vars['action_name'] ?? 'unknown' },
      { label: 'Monitor', value: vars['monitor_name'] ?? UNKNOWN_MONITOR },
      { label: 'Triggered when', value: vars['trigger_status'] === 'up' ? 'monitor was back up' : 'monitor was down' },
      { label: 'Attempts', value: vars['attempts'] ?? '' },
    ],
    ...errorDetail(vars, 'Error'),
    at: vars['checked_at'] ?? 'unknown',
    atLabel: 'Checked at',
  }
}

/** What the notification channels say about one event, read from the variables the event was raised with. */
export function noticeFromVars(vars: Vars): Notice {
  switch (vars['event_type']) {
    case 'action': return actionNotice(vars)
    case 'certificate': return certificateNotice(vars)
    case 'latency': return latencyNotice(vars)
    default: return alertNotice(vars)
  }
}

function worstStatus(rows: DeliveryRow[]): string {
  if (rows.some((row) => row.targetStatus === 'down')) return 'down'
  if (rows.some((row) => row.targetStatus === 'degraded')) return 'degraded'
  // A digest of speed events that holds one slowdown is about a slowdown, whatever came first.
  if (rows.some((row) => row.targetStatus === 'latency-slow')) return 'latency-slow'
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
