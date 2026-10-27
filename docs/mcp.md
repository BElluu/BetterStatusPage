# MCP server for AI agents

> [!WARNING]
> **Not released yet.** This feature is on `main` but not in a published release. To try it, build the image yourself from the `main` branch (see [Deployment](deployment.md)).

BetterStatusPage can answer an AI agent such as Claude Code through the [Model Context Protocol](https://modelcontextprotocol.io). Connect the agent to `/mcp` and ask it things like *"what is down right now?"*, *"why did the payments monitor flap last night?"* or *"were the alerts for that outage delivered?"*. It reads the same data as the admin console, and only what the API token you give it may read.

The agent can **look** with a token that may read. It can **act** only when an administrator has also allowed changes (see below) and the token may write: open and update incidents, schedule maintenance, run a check and create or update monitors. No object can be deleted, and tools that take a list replace it whole. Use a read-only token for everyday questions and a separate one for changes, and leave **Allow agents to make changes** off until you need it.

---

## Turn it on

Administrators switch it on in the admin console, with the **MCP** button next to **New token** under **Administration → API tokens**. No restart and no `.env` change are needed, and it works at once.

| Switch | Does | Confirmed with |
|---|---|---|
| **Allow AI agents to connect** | Off by default. While it is off, `/mcp` answers `404`, as an address that is not there does, before the caller is looked at. | Your password, or for a single sign-on session a confirmation at your identity provider |
| **Allow agents to make changes** | Off by default, and only available while the first switch is on. Off: agents are offered only the tools that read, whatever their token may do. On: tools that change data are offered to tokens that have a write permission. | The same |

Turning something **off** needs no confirmation, so it is a quick way to cut agents off. Turning MCP off also turns the changes off, so it comes back read-only. Only an administrator signed in to the console can change these switches: an API token never can, even one with every permission. Each change is recorded in the [audit log](users-and-roles.md#audit-log) as **MCP**.

The dialog also shows the address to use and the `claude mcp add` command to copy.

Set [`PUBLIC_URL`](deployment.md#environment-variables) too. With it set, a request is accepted only when its `Host` header is that address, so open `/mcp` through the public address and not through `http://server:3000` or `http://localhost:3000`, and let your reverse proxy pass the original `Host` (`proxy_set_header Host $host;`, as in the [Nginx example](deployment.md)). Put it behind your reverse proxy and TLS like the rest of the application; answers are plain JSON, so no streaming settings are needed.

---

## Create a token

The agent signs in with an [API token](api.md#api-tokens), and **only** a token: a browser session cookie is never accepted, so a web page cannot use the endpoint on your behalf.

1. Open **Administration → API tokens → New token**.
2. Click **Read only**, or tick just the permissions the agent needs. Add `incidents:write`, `maintenance:write` or `monitors:write` only for an agent that should change something.
3. Copy the token. It is shown once.

The permissions decide which tools the agent sees. A token with only `monitors:read` is offered seven tools; the audit log, deliveries and system health stay out of reach until you grant `audit:read`, `channels:read` and `system:read`. Give the agent as little as the job needs, and set an expiry.

---

## Connect Claude Code

```sh
claude mcp add --transport http bsp https://status.example.com/mcp \
  --header "Authorization: Bearer bsp_your_token"
```

Any other client that speaks MCP over HTTP works the same way: the URL is `https://<your-host>/mcp` and the token goes in an `Authorization: Bearer` header.

---

## The tools

| Tool | Answers | Permission |
|---|---|---|
| `status_overview` | Monitors per status, the ones that are not up, open incidents, running maintenance. Start here. | `monitors:read` (incidents and maintenance are added when the token can read them) |
| `list_monitors` | Monitors with status, interval, last check, tags; filter by status, type or tag | `monitors:read` |
| `get_monitor` | One monitor with its configuration (secrets masked), thresholds and activity | `monitors:read` |
| `monitor_stats` | Uptime, failures, response-time percentiles and recent failures over a window | `monitors:read` |
| `monitor_results` | Individual check results, newest first, optionally failures only | `monitors:read` |
| `uptime_report` | Uptime per monitor for a range of days | `reports:read` |
| `list_incidents` | Incidents with impact, status, affected monitors and updates | `incidents:read` |
| `list_maintenance` | Maintenance windows, or only the running ones | `maintenance:read` |
| `list_notification_deliveries` | Alerts sent to channels, with status, attempts, errors and the reason one was held back | `channels:read` |
| `get_notification_delivery` | One delivery with every attempt | `channels:read` |
| `audit_log` | Who changed what and when, with before and after values | `audit:read` |
| `system_health` | Database, scheduler, delivery, backups, static fallback, updates | `system:read` |
| `monitor_config_fields` | Every monitor type with a summary; with a type, each config field (required, whether the API refuses it when missing, allowed values, default, what the console starts with, range, secret) and the settings every monitor has. Call it before creating or changing a monitor, because an option that is off does not appear in `get_monitor` | `monitors:read` |
| `monitor_dependencies` | The monitors a monitor depends on, with names | `monitors:read` |
| `list_channels` | Notification channels: type, enabled state, recovery and alert-hygiene settings and the host a webhook sends to. Addresses, recipients and secrets are not returned | `channels:read` |
| `monitor_channels` | Which channels one monitor notifies | `channels:read` |
| `list_incident_templates` | Templates for automatic incidents | `incidents:read` |
| `list_actions` | [Actions](actions.md): name, method, the host called, approval. The request itself is not returned. Administrator tokens | `actions:read` |
| `list_action_runs` | Action run history, newest first, with status and last error | `actions:read` |
| `subscriber_counts` | Subscribers by status, no addresses | `subscribers:read` |

### Tools that change something

Offered only while **Allow agents to make changes** is on, and only to a token with the write permission. A client such as Claude Code asks you before it runs one that is marked destructive.

| Tool | Does | Permission | Marked |
|---|---|---|---|
| `incident_create_draft` | Creates an incident as a **draft**: operators only, nobody is notified | `incidents:write` | write |
| `incident_publish` | Publishes a draft on the public page. Cannot be undone | `incidents:write` | destructive |
| `incident_post_update` | Posts an update with a status; `resolved` closes the incident. On a draft nobody is notified | `incidents:write` | destructive |
| `incident_update` | Changes only the title and/or impact of an incident that is not resolved (a new title removes its translations). On a published one it is public, and impact decides degraded or down | `incidents:write` | destructive |
| `incident_set_monitors` | Replaces the monitors an incident affects | `incidents:write` | destructive |
| `maintenance_create` | Schedules a one-time window for **named** monitors, ending in the future and lasting at most 7 days (alerts are silenced while it runs) | `maintenance:write` | destructive |
| `maintenance_update` | Changes only the passed settings of a one-time window (name, description, times, monitors), with the same limits. Repeating windows are edited in the admin console | `maintenance:write` | destructive |
| `maintenance_end` | Ends a window that is running now: the banner goes and alerts resume | `maintenance:write` | destructive |
| `monitor_update` | Changes only the settings passed (interval, timeout, retries, thresholds, name, or some config fields) and leaves the rest of the monitor as it is, like editing it in the admin console. It refuses a change that would drop a stored secret. A longer threshold, another address or a new name are visible or hide outages, hence the approval | `monitors:write` | destructive |
| `monitor_create` | Creates one monitor of any type, validated like in the admin console. It starts checking the address in its config at once | `monitors:write` | destructive |
| `monitor_set_dependencies` | Replaces the monitors one monitor depends on. A wrong list can hide a real outage; cycles are refused | `monitors:write` | destructive |
| `monitor_check_now` | Runs one monitor's check now and returns the monitor. It can change the status, send alerts and open an automatic incident | `monitors:write` | destructive |
| `monitors_validate` | Checks `kind: Monitor` YAML and returns the plan and a `planDigest`; changes nothing | `monitors:write` | write |
| `monitors_apply` | Creates monitors from that YAML, only when `planDigest` still matches. Replacing an existing monitor also needs `allowUpdates: true`; to change one setting use `monitor_update` | `monitors:write` | destructive |

Rules built into them:

- `notifySubscribers` has **no default** on `incident_publish`, `incident_post_update` and `maintenance_create`: the agent has to decide, and you see it in the approval.
- `monitor_create` takes the config as the API does (look at a monitor of the same type with `get_monitor`). **Do not give an agent passwords or tokens**: they would pass through the chat. Create a vault secret in the admin console and let a person add the reference or the credentials there: referencing a vault secret needs `vault:use`, and a token that has it can send any vault secret to an address the agent chooses, so **do not give `vault:use` to an agent token**. The heartbeat URL of a new `webhook` monitor is not given to the agent; copy it from the admin console.
- Times you send are ISO 8601 with an offset (`2026-11-02T22:00:00+01:00` or `...Z`); a time without one is refused.
- `monitors_apply` accepts only `kind: Monitor` documents. Channels and actions make requests to addresses someone writes down, so they stay out. It never prunes. A document **replaces the whole monitor**: notification channels, dependencies and automatic incidents it does not list are removed from it. So `monitors_validate` reports `updatesExisting`, and `monitors_apply` refuses such a plan until the agent passes `allowUpdates: true`, which it should do only after you agreed. The plan lists changed field names, not old and new values, so read the YAML in the approval.
- `planDigest` ties the apply to the YAML that was validated and catches drift between the two calls. It is not an approval: the approval is your client asking before it runs a destructive tool.
- **A new monitor (`monitor_create` or `monitors_apply`) makes requests to the address in its configuration**, and `monitor_check_now` runs it, so a token that may write monitors can probe your internal network and read the result (addresses of cloud metadata services are blocked). This is the same power as `monitors:write` through the API; give it only to an agent you trust with it.
- Every change goes through the admin API with the token, so it is validated, rate-limited and **recorded in the [audit log](users-and-roles.md#audit-log)** as `token: <token name>`, with the before and after values, like a change from a script.

Every other tool is marked read-only. Lists are limited: most take `limit` and `page` (up to 50 rows), `list_monitors` up to 100, `monitor_results` up to 200 of the newest 1000 checks, and `list_maintenance` returns the 100 windows that start latest.

---

## What it does not do

- **Nothing is deleted.** There are no tools to delete an incident, a window or a monitor, or to change users, tokens, vaults, channels, actions, subscribers or the appearance of the page. There is no monitor **Test** button either, though a new monitor plus `monitor_check_now` can reach an address (see above).
- **No secrets.** The [vault](vault.md) is out of reach, secrets in a monitor's configuration stay masked, and the token of a [heartbeat URL](monitors.md#webhook-passive-heartbeat) is left out of every result.
- **No requests to other systems by itself.** A tool only talks to the application; the monitors you create are what reach other systems.

---

## Safety

- **A tool is a request to the admin API** made with the agent's own token. Its permissions, rate limit and checks apply exactly as for a script; the endpoint adds nothing a token could not already do.
- **Text in results is data.** Monitor and incident names, error messages from the systems you monitor, heartbeat messages and user emails can contain whatever someone put there, including sentences aimed at an AI. Control and escape characters, bidirectional controls, zero-width and invisible characters (including Unicode tag characters and variation selectors) are removed, every text is cut to 2000 characters, anything nested deeper than 12 levels is replaced by a placeholder, and the agent is told when it connects to treat such text as data. A model can still be misled by cleverly worded text, so grant the narrowest permissions you can, keep the tools that change something behind manual approval, and read what an agent is about to publish.
- **One call per request.** A JSON-RPC batch is refused, so the rate limits count what is done.
- **A web page cannot call it.** A request with an `Origin` header is refused (only your own `PUBLIC_URL` origin is let through), and with `PUBLIC_URL` set a different `Host` is refused too.
- **Size is bounded.** A result is limited to 64 KB: a list is shortened and marked `truncated`, anything else that large is refused with a message to narrow the query; a request body is limited to 256 KB; the endpoint allows 300 requests a minute per client address, and the token's own budget of 300 a minute is spent by the calls behind each tool.
- **Reading is not audited.** The [audit log](users-and-roles.md#audit-log) records changes, including those made through MCP, but not reads. A token's *last used* time on **API tokens** shows that it is in use; revoke the token to cut the agent off at once.

---

## Troubleshooting

| Answer | Cause |
|---|---|
| `404` | MCP is off. An administrator turns on **Allow AI agents to connect** (**MCP** button on **Administration → API tokens**). |
| `401` | The token is missing, wrong, expired or revoked, or was sent as a cookie instead of `Authorization: Bearer`. |
| `403` ("Host header does not match") | `PUBLIC_URL` is set and the client used another address. Use the public URL. |
| `403` ("Requests from a web page…") | The client sent an `Origin` header, as a browser does. Use a command-line or desktop MCP client. |
| `429` | Too many requests. Wait a minute. |
| A tool is missing | The token lacks its permission, or (for a tool that changes data) **Allow agents to make changes** is off. |
| A tool answers `403: This token does not have…` | Same cause, found when the tool read through the API. |
