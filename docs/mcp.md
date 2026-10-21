# MCP server for AI agents

> [!WARNING]
> **Not released yet.** This feature is on `main` but not in a published release. To try it, build the image yourself from the `main` branch (see [Deployment](deployment.md)).

BetterStatusPage can answer an AI agent such as Claude Code through the [Model Context Protocol](https://modelcontextprotocol.io). Connect the agent to `/mcp` and ask it things like *"what is down right now?"*, *"why did the payments monitor flap last night?"* or *"were the alerts for that outage delivered?"*. It reads the same data as the admin console, and only what the API token you give it may read.

This first version is **read-only**: the agent can look, it cannot change anything.

---

## Turn it on

The endpoint is **off by default**. Set this in `.env` and restart:

```env
MCP_ENABLED=true
```

Anything but `true` or `false` stops the server from starting, so a typo cannot leave it half on. While it is off, `/mcp` does not exist and answers `404`.

Set [`PUBLIC_URL`](deployment.md#environment-variables) too. With it set, a request is accepted only when its `Host` header is that address, so open `/mcp` through the public address and not through `http://server:3000` or `http://localhost:3000`, and let your reverse proxy pass the original `Host` (`proxy_set_header Host $host;`, as in the [Nginx example](deployment.md)). Put it behind your reverse proxy and TLS like the rest of the application; answers are plain JSON, so no streaming settings are needed.

---

## Create a token

The agent signs in with an [API token](api.md#api-tokens), and **only** a token: a browser session cookie is never accepted, so a web page cannot use the endpoint on your behalf.

1. Open **Administration → API tokens → New token**.
2. Click **Read only**, or tick just the permissions the agent needs.
3. Copy the token. It is shown once.

The permissions decide which tools the agent sees. A token with only `monitors:read` is offered five tools; the audit log, deliveries and system health stay out of reach until you grant `audit:read`, `channels:read` and `system:read`. Give the agent as little as the job needs, and set an expiry.

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

Every tool is marked read-only. Lists are limited: most take `limit` and `page` (up to 50 rows), `list_monitors` up to 100, `monitor_results` up to 200 of the newest 1000 checks, and `list_maintenance` returns the 100 windows that start latest.

---

## What it does not do

- **Nothing is changed.** There are no tools to open an incident, schedule maintenance, edit a monitor or remove anything.
- **No secrets.** The [vault](vault.md) is out of reach, secrets in a monitor's configuration stay masked, and the token of a [heartbeat URL](monitors.md#webhook-passive-heartbeat) is left out of every result.
- **No requests to other systems.** A tool only reads from the application itself.

---

## Safety

- **A tool is a request to the admin API** made with the agent's own token. Its permissions, rate limit and checks apply exactly as for a script; the endpoint adds nothing a token could not already read.
- **Text in results is data.** Monitor and incident names, error messages from the systems you monitor, heartbeat messages and user emails can contain whatever someone put there, including sentences aimed at an AI. Control and escape characters, bidirectional controls, zero-width and invisible characters (including Unicode tag characters and variation selectors) are removed, every text is cut to 2000 characters, anything nested deeper than 12 levels is replaced by a placeholder, and the agent is told when it connects to treat such text as data. A model can still be misled by cleverly worded text, so grant the narrowest permissions you can and keep write tools (when they exist) behind manual approval.
- **A web page cannot call it.** A request with an `Origin` header is refused (only your own `PUBLIC_URL` origin is let through), and with `PUBLIC_URL` set a different `Host` is refused too.
- **Size is bounded.** A result is limited to 64 KB: a list is shortened and marked `truncated`, anything else that large is refused with a message to narrow the query; a request body is limited to 256 KB; the endpoint allows 300 requests a minute per client address, and the token's own budget of 300 a minute is spent by the calls behind each tool.
- **Reading is not audited.** The [audit log](users-and-roles.md#audit-log) records changes. A token's *last used* time on **API tokens** shows that it is in use; revoke the token to cut the agent off at once.

---

## Troubleshooting

| Answer | Cause |
|---|---|
| `404` | `MCP_ENABLED` is not `true`, or the instance was not restarted after changing it. |
| `401` | The token is missing, wrong, expired or revoked, or was sent as a cookie instead of `Authorization: Bearer`. |
| `403` ("Host header does not match") | `PUBLIC_URL` is set and the client used another address. Use the public URL. |
| `403` ("Requests from a web page…") | The client sent an `Origin` header, as a browser does. Use a command-line or desktop MCP client. |
| `429` | Too many requests. Wait a minute. |
| A tool is missing | The token lacks its permission. Create a token that has it. |
| A tool answers `403: This token does not have…` | Same cause, found when the tool read through the API. |
