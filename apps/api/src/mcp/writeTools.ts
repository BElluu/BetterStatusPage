import { createHash } from 'node:crypto'
import { defineTool, McpToolError, type McpTool, type McpToolContext } from '@better-kit/mcp'
import { parseAllDocuments } from 'yaml'
import { z } from 'zod'

const ADMIN = '/api/v1/admin'
const INCIDENTS_LOOKED_AT = 500
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const START_GRACE_MS = 5 * 60 * 1000
const YAML_TYPE = 'application/yaml; charset=utf-8'
const MAX_YAML_CHARS = 100_000

type Row = Record<string, unknown>

const id = (what: string) => z.number().int().min(1).describe(what)
const status = z.enum(['investigating', 'identified', 'monitoring', 'resolved'])
const impact = z.enum(['minor', 'major', 'critical'])
/** Required with no default: whether people are emailed is the caller's decision every time. */
const notifySubscribers = z.boolean().describe('Whether to notify subscribers of the status page (email, webhook, Slack feed). Decide explicitly.')

function time(value: string, name: string): number {
  const ms = Date.parse(value)
  if (Number.isNaN(ms) || !ISO_WITH_OFFSET.test(value)) throw new McpToolError(`${name} must be an ISO 8601 time with an offset, for example 2026-11-02T22:00:00+01:00`)
  return ms
}

/** The incident from the newest ones; there is no route for a single incident. */
async function findIncident(ctx: McpToolContext, incidentId: number): Promise<Row> {
  const list = await ctx.get(`${ADMIN}/incidents?page=1&limit=${INCIDENTS_LOOKED_AT}`)
  const found = (Array.isArray(list) ? (list as Row[]) : []).find((incident) => incident['id'] === incidentId)
  if (!found) throw new McpToolError(`404: Incident ${incidentId} was not found among the ${INCIDENTS_LOOKED_AT} newest`)
  return found
}

const incidentCreateDraft = defineTool({
  name: 'incident_create_draft',
  title: 'Create a draft incident',
  description: 'Creates an incident as a DRAFT: only operators see it and nobody is notified. Publish it with incident_publish when it is ready.',
  scope: 'incidents:write',
  access: 'write',
  input: {
    title: z.string().min(1).max(200),
    impact: impact.default('minor'),
    status: status.default('investigating'),
    monitorIds: z.array(z.number().int().min(1)).max(100).default([]).describe('Affected monitors'),
  },
  handler: (args, ctx) => ctx.send('POST', `${ADMIN}/incidents`, { ...args, draft: true, notifySubscribers: false }),
})

const incidentPublish = defineTool({
  name: 'incident_publish',
  title: 'Publish a draft incident',
  description: 'Makes a draft incident visible on the public status page. This cannot be undone. With notifySubscribers it also sends it to subscribers.',
  scope: 'incidents:write',
  access: 'destructive',
  input: { id: id('Incident id'), notifySubscribers },
  handler: (args, ctx) => ctx.send('PATCH', `${ADMIN}/incidents/${args.id}`, { draft: false, notifySubscribers: args.notifySubscribers }),
})

const incidentPostUpdate = defineTool({
  name: 'incident_post_update',
  title: 'Post an incident update',
  description: 'Adds an update with a new status to an incident; status "resolved" closes it. On a published incident it is public, and subscribers are notified when notifySubscribers is true. On a draft nobody is notified.',
  scope: 'incidents:write',
  access: 'destructive',
  input: { id: id('Incident id'), body: z.string().min(1).max(5000), status, notifySubscribers },
  async handler(args, ctx) {
    const incident = await findIncident(ctx, args.id)
    // Posting to a closed incident would reopen it on the public page; that is done in the admin console.
    if (incident['status'] === 'resolved') throw new McpToolError('This incident is resolved. Reopening it is done in the admin console')
    // A draft has not been announced, so an update to it must not be either.
    const notify = incident['draft'] === true || incident['draft'] === 1 ? false : args.notifySubscribers
    return ctx.send('POST', `${ADMIN}/incidents/${args.id}/updates`, { body: args.body, status: args.status, notifySubscribers: notify })
  },
})

const incidentUpdate = defineTool({
  name: 'incident_update',
  title: 'Change the title or impact of an incident',
  description: 'Changes the title and/or impact of an incident that is not resolved, nothing else. On a published incident this is visible on the public page, impact decides whether its monitors show as degraded or down, and a new title removes its translations. Use incident_post_update to change the status.',
  scope: 'incidents:write',
  access: 'destructive',
  input: { id: id('Incident id'), title: z.string().min(1).max(200).optional(), impact: impact.optional() },
  async handler({ id: incidentId, ...changes }, ctx) {
    if (changes.title === undefined && changes.impact === undefined) throw new McpToolError('Pass a title or an impact to change')
    // Rewriting a closed incident would rewrite the public history.
    if ((await findIncident(ctx, incidentId))['status'] === 'resolved') throw new McpToolError('A resolved incident cannot be changed from here')
    return ctx.send('PATCH', `${ADMIN}/incidents/${incidentId}`, changes)
  },
})

const incidentSetMonitors = defineTool({
  name: 'incident_set_monitors',
  title: 'Set the monitors of an incident',
  description: 'Replaces the list of monitors an incident affects. On a published incident an active minor incident marks them degraded, major or critical marks them down on the public page. Not for a resolved incident.',
  scope: 'incidents:write',
  access: 'destructive',
  input: { id: id('Incident id'), monitorIds: z.array(z.number().int().min(1)).max(100).describe('Ids from list_monitors; the whole list replaces the current one') },
  async handler(args, ctx) {
    if ((await findIncident(ctx, args.id))['status'] === 'resolved') throw new McpToolError('A resolved incident cannot be changed from here')
    return ctx.send('POST', `${ADMIN}/incidents/${args.id}/monitors`, { monitorIds: args.monitorIds })
  },
})

const maintenanceCreate = defineTool({
  name: 'maintenance_create',
  title: 'Schedule a maintenance window',
  description: 'Schedules a one-time maintenance window for the listed monitors. While it runs their alerts are silenced and the public page shows a maintenance banner. Name the monitors; it may last at most 7 days and must end in the future.',
  scope: 'maintenance:write',
  access: 'destructive',
  input: {
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    startsAt: z.string().describe('ISO 8601 time with an offset'),
    endsAt: z.string().describe('ISO 8601 time with an offset'),
    monitorIds: z.array(z.number().int().min(1)).min(1).max(100).describe('Ids from list_monitors of the monitors whose alerts are silenced'),
    notifySubscribers,
  },
  handler(args, ctx) {
    const startsAt = time(args.startsAt, 'startsAt')
    const endsAt = time(args.endsAt, 'endsAt')
    if (endsAt <= Date.now()) throw new McpToolError('endsAt must be in the future')
    if (endsAt - startsAt > MAX_WINDOW_MS) throw new McpToolError('A window made from here may last at most 7 days')
    if (startsAt < Date.now() - MAX_WINDOW_MS) throw new McpToolError('startsAt cannot be that far in the past')
    return ctx.send('POST', `${ADMIN}/maintenance`, {
      name: args.name, description: args.description, monitorIds: args.monitorIds, notifySubscribers: args.notifySubscribers, startsAt, endsAt,
    })
  },
})

const maintenanceUpdate = defineTool({
  name: 'maintenance_update',
  title: 'Reschedule or edit a maintenance window',
  description: 'Changes only the passed settings of a one-time maintenance window: name, description, times, monitors. The same limits apply as when scheduling it (ends in the future, at most 7 days; checked when a time is changed). Recurring windows are edited in the admin console.',
  scope: 'maintenance:write',
  access: 'destructive',
  input: {
    id: id('Maintenance window id'),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    startsAt: z.string().optional().describe('ISO 8601 time with an offset'),
    endsAt: z.string().optional().describe('ISO 8601 time with an offset'),
    monitorIds: z.array(z.number().int().min(1)).min(1).max(100).optional().describe('Replaces the monitors of the window (ids from list_monitors)'),
  },
  async handler({ id: windowId, startsAt, endsAt, ...rest }, ctx) {
    const current = (await ctx.get(`${ADMIN}/maintenance/${windowId}`)) as Row
    if (current['recurrence'] !== 'none' && current['recurrence'] !== undefined && current['recurrence'] !== null) {
      throw new McpToolError('This window repeats. Edit it in the admin console')
    }
    const patch: Row = { ...rest }
    if (startsAt !== undefined) patch['startsAt'] = time(startsAt, 'startsAt')
    if (endsAt !== undefined) patch['endsAt'] = time(endsAt, 'endsAt')
    const from = (patch['startsAt'] ?? current['startsAt']) as number
    const to = (patch['endsAt'] ?? current['endsAt']) as number
    if (Object.values(patch).every((value) => value === undefined)) throw new McpToolError('Pass at least one setting to change')
    if (to <= Date.now()) throw new McpToolError('endsAt must be in the future')
    if ((startsAt !== undefined || endsAt !== undefined) && to - from > MAX_WINDOW_MS) throw new McpToolError('A window changed from here may last at most 7 days')
    if (startsAt !== undefined && from < Math.min(current['startsAt'] as number, Date.now()) - START_GRACE_MS) throw new McpToolError('startsAt cannot be moved into the past')
    return ctx.send('PATCH', `${ADMIN}/maintenance/${windowId}`, patch)
  },
})

const maintenanceEnd = defineTool({
  name: 'maintenance_end',
  title: 'End a running maintenance window',
  description: 'Ends a maintenance window that is running now (only the current occurrence of a recurring one). Alerts for its monitors resume.',
  scope: 'maintenance:write',
  access: 'destructive',
  input: { id: id('Maintenance window id') },
  handler: (args, ctx) => ctx.send('POST', `${ADMIN}/maintenance/${args.id}/end`, {}),
})

const monitorCheckNow = defineTool({
  name: 'monitor_check_now',
  title: 'Check a monitor now',
  description: 'Runs the check of one monitor right away and returns the monitor with its new status. This can change its status, send alerts and open an automatic incident.',
  scope: 'monitors:write',
  access: 'destructive',
  input: { id: id('Monitor id') },
  async handler(args, ctx) {
    const { webhookToken: _hidden, config: _config, ...monitor } = (await ctx.send('POST', `${ADMIN}/monitors/${args.id}/check-now`, {})) as Row
    return monitor
  },
})

const HTTP_METHODS = ['GET', 'POST', 'HEAD']

/**
 * The API does not check the method of an HTTPS monitor, and the monitor sends it to its URL at every interval, so an
 * agent could make one that sends DELETE. The admin console offers these three, and so does an agent.
 */
function checkMethod(config: Row | undefined): void {
  const method = config?.['method']
  if (method === undefined) return
  if (typeof method !== 'string' || !HTTP_METHODS.includes(method.toUpperCase())) {
    throw new McpToolError(`config.method must be one of ${HTTP_METHODS.join(', ')}: a monitor sends it to its address at every check`)
  }
}

/** Settings every monitor has; their meaning and ranges are in monitor_config_fields. The API validates them. */
const monitorSettings = {
  intervalSecs: z.number().int().optional().describe('Seconds between checks'),
  timeoutMs: z.number().int().optional(),
  retries: z.number().int().optional(),
  failureThreshold: z.number().int().optional().describe('Consecutive failures before an alert'),
  recoveryThreshold: z.number().int().optional(),
  tags: z.array(z.object({ label: z.string().min(1).max(40), color: z.string().min(1).max(20) })).max(20).optional().describe('Replaces the tags'),
  autoIncidentMinutes: z.number().int().nullable().optional().describe('Minutes down before an incident opens by itself; null turns it off'),
  autoIncidentMode: z.enum(['draft', 'published']).optional().describe('published needs incidents:write'),
  autoIncidentTemplateId: z.number().int().nullable().optional().describe('See list_incident_templates; null = the default template. A template needs incidents:write'),
  latencyAlertFactor: z.number().nullable().optional().describe('Slower-than-usual alert factor, 1.5 to 10; null turns it off'),
  latencyAlertWindowMinutes: z.number().int().optional(),
  latencyAlertMinDeltaMs: z.number().int().optional(),
  latencyAlertSustain: z.number().int().optional(),
}

const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'

/** Where a masked (stored) secret sits in a config, as dotted paths. */
function maskedPaths(value: unknown, prefix = ''): string[] {
  if (value === MASK) return [prefix]
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, each]) => maskedPaths(each, prefix ? `${prefix}.${key}` : key))
}

const monitorUpdate = defineTool({
  name: 'monitor_update',
  title: 'Change settings of one monitor',
  description: 'Changes only the settings you pass, like editing the monitor in the admin console: everything else stays, including its channels, dependencies, automatic incident and secrets. `config` holds just the config fields to change (for example { "url": "https://..." }); the other config fields are kept. Covers every setting of the monitor form except its channels, actions and dependencies (monitor_channels is read-only; monitor_set_dependencies changes dependencies). The type and key cannot be changed.',
  scope: 'monitors:write',
  access: 'destructive',
  input: {
    id: id('Monitor id'),
    name: z.string().min(1).max(200).optional(),
    ...monitorSettings,
    config: z.record(z.string(), z.unknown()).optional().describe('Only the config fields to change (see monitor_config_fields); a nested object such as auth is replaced whole'),
  },
  async handler({ id: monitorId, config, ...settings }, ctx) {
    checkMethod(config)
    const patch: Row = { ...settings }
    if (Object.values(patch).every((value) => value === undefined) && !config) throw new McpToolError('Pass at least one setting to change')
    if (config) {
      // The stored config comes back with secrets masked; sending the mask back keeps them.
      const current = (await ctx.get(`${ADMIN}/monitors/${monitorId}`)) as Row
      const merged = { ...(current['config'] as Row), ...config }
      const lost = maskedPaths(current['config']).filter((path) => !maskedPaths(merged).includes(path))
      if (lost.length > 0) throw new McpToolError(`This would drop a stored secret (${lost.join(', ')}). Pass the whole nested object including the masked value, or change it in the admin console`)
      patch['config'] = merged
    }
    const { webhookToken: _hidden, config: _config, ...monitor } = (await ctx.send('PATCH', `${ADMIN}/monitors/${monitorId}`, patch)) as Row
    return monitor
  },
})

const monitorCreate = defineTool({
  name: 'monitor_create',
  title: 'Create a monitor',
  description: 'Creates one monitor of any type, validated like in the admin console (the error says what is missing). It starts checking the address in its config at once, so it makes requests to that address. NEVER put a password or token in config here: create a vault secret in the admin console and reference it, or add the credentials there. Call monitor_config_fields with the type first to see the config fields and settings. Referencing a vault secret needs the vault:use permission, which an agent token should not have.',
  scope: 'monitors:write',
  access: 'destructive',
  input: {
    name: z.string().min(1).max(200),
    type: z.string().min(1).describe('For example https, ping, dns, postgresql, redis, ssh, tls, domain, docker, webhook'),
    config: z.record(z.string(), z.unknown()),
    ...monitorSettings,
  },
  async handler(args, ctx) {
    checkMethod(args.config)
    const { webhookToken, config: _config, ...monitor } = (await ctx.send('POST', `${ADMIN}/monitors`, args)) as Row
    return webhookToken ? { ...monitor, note: 'This is a heartbeat monitor. Its URL is shown in the admin console; it is not given to the agent.' } : monitor
  },
})

const monitorSetDependencies = defineTool({
  name: 'monitor_set_dependencies',
  title: 'Set the dependencies of a monitor',
  description: 'Replaces the list of monitors this monitor depends on. While one of them is down, this monitor shows Dependency Issue and its alert is held back, so a wrong list can hide a real outage. Cycles are refused.',
  scope: 'monitors:write',
  access: 'destructive',
  input: { id: id('Monitor id'), dependsOnIds: z.array(z.number().int().min(1)).max(50).describe('Ids from list_monitors; the whole list replaces the current one, [] removes all dependencies') },
  async handler(args, ctx) {
    await ctx.send('PUT', `${ADMIN}/monitors/${args.id}/dependencies`, { dependsOnIds: args.dependsOnIds })
    // The API drops ids that do not exist, so say what was stored.
    const { dependsOnIds } = (await ctx.get(`${ADMIN}/monitors/${args.id}/dependencies`)) as { dependsOnIds: number[] }
    return { monitorId: args.id, dependsOnIds }
  },
})

/** Only monitors: other kinds make requests to addresses someone wrote down, and pruning deletes. */
function monitorYaml(yaml: string): string {
  if (yaml.length > MAX_YAML_CHARS) throw new McpToolError(`The YAML is longer than ${MAX_YAML_CHARS} characters`)
  const documents = parseAllDocuments(yaml).filter((document) => document.contents !== null)
  let kinds: unknown[]
  try {
    if (documents.some((document) => document.errors.length > 0)) throw new Error('unreadable')
    kinds = documents.map((document) => (document.toJS() as Row | null)?.['kind'])
  } catch {
    throw new McpToolError('The YAML cannot be read')
  }
  // The same rule as monitor_create: an HTTPS monitor sends this method to its address at every check.
  for (const document of documents) {
    const config = (document.toJS() as Row | null)?.['config']
    checkMethod(config && typeof config === 'object' && !Array.isArray(config) ? config as Row : undefined)
  }
  if (kinds.length === 0 || kinds.some((kind) => kind !== 'Monitor')) throw new McpToolError('Only documents with kind: Monitor are accepted here')
  return yaml
}

/** Binds the plan to the exact text, so a changed document never passes with the digest of another. */
const digestOf = (yaml: string, plan: unknown): string =>
  createHash('sha256').update(yaml).update('\0').update(JSON.stringify(plan)).digest('hex').slice(0, 32)

/** Whether the plan changes a monitor that already exists. A document replaces the whole monitor: links, dependencies and automatic incidents it leaves out are removed. */
const updates = (plan: unknown): boolean =>
  ((plan as { changes?: Array<{ action?: string }> } | null)?.changes ?? []).some((change) => change.action === 'update')

const monitorsValidate = defineTool({
  name: 'monitors_validate',
  title: 'Check monitor YAML',
  description: 'Checks monitor documents (kind: Monitor, as in the configuration export) and returns what applying them would create or change, without changing anything. Returns a planDigest for monitors_apply.',
  scope: 'monitors:write',
  access: 'write',
  input: { yaml: z.string().min(1).describe('One or more YAML documents with kind: Monitor') },
  async handler(args, ctx) {
    const plan = await ctx.send('POST', `${ADMIN}/config/validate`, monitorYaml(args.yaml), YAML_TYPE)
    return { plan, planDigest: digestOf(args.yaml, plan), updatesExisting: updates(plan) }
  },
})

const monitorsApply = defineTool({
  name: 'monitors_apply',
  title: 'Apply monitor YAML',
  description: 'Creates monitors from the YAML that monitors_validate checked. The plan is computed again and must match planDigest, or nothing is changed. To change a setting of one existing monitor use monitor_update instead. Replacing an EXISTING monitor with a document needs allowUpdates: a document replaces the whole monitor, so channels, dependencies and automatic incidents it does not list are removed from it. Monitors are never deleted. A new monitor makes requests to the address in its configuration.',
  scope: 'monitors:write',
  access: 'destructive',
  input: {
    yaml: z.string().min(1),
    planDigest: z.string().min(1).describe('From monitors_validate for this same YAML'),
    allowUpdates: z.boolean().default(false).describe('Set only after the user agreed to replace the existing monitors the plan lists as updates'),
  },
  async handler(args, ctx) {
    const yaml = monitorYaml(args.yaml)
    const plan = await ctx.send('POST', `${ADMIN}/config/validate`, yaml, YAML_TYPE)
    if (digestOf(args.yaml, plan) !== args.planDigest) throw new McpToolError('The plan changed since monitors_validate (or the YAML is a different one). Run monitors_validate again and review it.')
    if (updates(plan) && !args.allowUpdates) throw new McpToolError('The plan changes existing monitors. Ask the user, then call again with allowUpdates: true')
    return ctx.send('POST', `${ADMIN}/config/apply`, yaml, YAML_TYPE)
  },
})

export const mcpWriteTools: readonly McpTool[] = [
  incidentCreateDraft, incidentPublish, incidentPostUpdate, incidentUpdate, incidentSetMonitors,
  maintenanceCreate, maintenanceUpdate, maintenanceEnd, monitorCreate, monitorUpdate, monitorSetDependencies, monitorCheckNow, monitorsValidate, monitorsApply,
]
