# Monitors

A monitor checks one thing on a schedule — a URL, a host, a DNS record, a database — or waits for
your own service to call in. This guide covers every monitor type, the fields in the monitor form,
authentication, certificate warnings, dependencies and the built-in test runner.

Monitors live under **Admin → Monitors** and can be managed by operators and administrators.

---

## Monitor types

| Type | Checks | Fails as **Down** when | Fails as **Degraded** when |
| --- | --- | --- | --- |
| **HTTPS** | A URL, with optional authentication | Wrong status code, timeout, connection or TLS error | The keyword is missing from the body |
| **Ping / TCP** | A host, by TCP connect or ICMP ping | The host does not answer in time | — |
| **DNS** | A record of a hostname | The lookup fails or times out | The expected value is not in the answer |
| **SQL Server** | A query against Microsoft SQL Server | Connection or query error, timeout | The first value returned does not match |
| **PostgreSQL** | A query against PostgreSQL | Connection or query error, timeout | The first value returned does not match |
| **MySQL / MariaDB** | A query against MySQL or MariaDB | Connection or query error, timeout | The first value returned does not match |
| **MongoDB** | A command against MongoDB | Connection or command error, timeout | The first value returned does not match |
| **Docker** | State and healthcheck of a container | The container does not exist, is stopped or paused, or the Docker API is unreachable | The container is restarting, unhealthy or still starting |
| **Webhook** | Requests your service sends in | No request arrives within the interval | — |

A monitor shows one of these statuses:

| Status | Meaning |
| --- | --- |
| **Pending** | Created, not checked yet |
| **Operational** | The last check passed |
| **Degraded** | The service answered, but not with what you expected |
| **Down** | The check failed |
| **Dependency Issue** | A monitor this one depends on is failing — see [Dependencies](#dependencies) |

Status changes reach the admin list and the public page live, without a reload.

---

## Common settings

These fields are in the form for every type. **Name** and **Type** come first, followed by the settings of the chosen type. The timing and alert fields below are grouped in a collapsed **Schedule & alerting** row at the end of the form, which shows their current values and opens on click.

| Field | Default | What it does |
| --- | --- | --- |
| **Name** | — | Shown in the admin console, in notifications and on the status page. Required, up to 200 characters. A technical [key](api.md#monitors-and-notification-channels-have-keys) is generated from it; it is not shown in the form and never changes. |
| **Type** | HTTPS | Chosen from a searchable list grouped by area (Web, Network, Data, Infrastructure, Inbound). Switching type resets the type-specific settings. |
| **Interval (s)** | `60` | How often the check runs. `10`–`86400`. For a webhook monitor, how long silence may last. |
| **Timeout (ms)** | `10000` | How long one attempt may take, authentication and redirects included. `1000`–`300000`. |
| **Attempts** | `1` | How many times one check is tried before it counts as down. `1–10`. |
| **Alert after (checks)** | `1` | Consecutive failed checks before an alert is sent. `1–20`. |
| **Recover after (checks)** | `1` | Consecutive successful checks before a recovery is sent. `1–20`. |

A few details:

- **Attempts** are retried right away, inside the same check, and only when the result is *down*.
  A degraded result is not retried. The check counts as down only if every attempt fails.
- **Alert after / Recover after** do not delay the status page, only notifications. See
  [Failure and recovery thresholds](alert-hygiene.md#failure-and-recovery-thresholds).
- The scheduler wakes every 10 seconds (`SCHEDULER_TICK_SECONDS`), so a check runs at most that
  long after its interval has passed.

The side tabs of the form hold the rest:

| Tab | Shown for | What it holds |
| --- | --- | --- |
| **Auth** | HTTPS | [Authentication](#https-authentication) |
| **Request** | HTTPS | Custom headers and request body |
| **Tags** | All | Coloured labels |
| **Alerts** | All | The [notification channels](notification-channels.md) this monitor alerts on |
| **Depends on** | All | [Dependencies](#dependencies) |

### Tags

Give a tag a label and pick one of ten colours. Labels you have already used elsewhere are
suggested as you type, with their colour. In the monitor list, click tags to filter it: a monitor
must carry **every** selected tag to stay visible. Status page subscribers can also follow tags —
see [Subscriptions](subscriptions.md#what-subscribers-can-receive).

### History

Every check result is stored with its status, response time and error message. The admin API
returns the last 30 days of a monitor's results (`GET /api/v1/admin/monitors/:id/history`). Results
older than 90 days are deleted every night; change that with `MONITOR_RESULT_RETENTION_DAYS` and
`MONITOR_RESULT_PURGE_CRON`. The [uptime reports](reports.md) page turns these results into uptime
per monitor for any date range, with CSV export.

The **Check now** button in the monitor list runs a check straight away. It is not offered for
webhook monitors.

### Monitor details

> [!WARNING]
> **Not released yet.** This feature is only in the `main` branch; build the image yourself from the `main` branch (see [Deployment](deployment.md)).

Click a monitor's name in the monitor list, or its tile under **System Components** on the
**Dashboard**, to open its page (`/admin/monitors/:id`); **Monitors** above the title leads back to
the list. The page shows the monitor over the last 24 hours, 7 days, 30 days or 90 days, up to the result retention:

- **Response time** chart, drawn like the one on the status page: average, p95 or maximum per
  period, with down and degraded periods shaded and a tooltip per point. Beside it: average,
  fastest, slowest, p50, p95 and p99.
- **Uptime bars** in the style of the status page, coloured by its uptime thresholds (99.9 / 99 / 95 %).
  One bar per hour for 24 hours, per 6 hours for 7 days and per UTC day for 30 and 90 days.
- **Summary**: uptime and the checks behind it (a failure not yet confirmed by the monitor's failure
  threshold does not lower uptime, like on the status page), failed checks, incidents and their mean
  time to resolve (MTTR).
- **Recent failures**: the latest 10 failed checks in the range, with their error messages. Next to
  them, the **incidents** linked to the monitor in that range.
- **Configuration** of the monitor: type, target, interval, timeout, alert and recovery thresholds,
  dependencies and, for HTTPS monitors, the days left on the certificate. A webhook monitor shows its
  **Webhook URL** here, with a **Copy** button.

**Check now** and **Edit** are available on the page too, so a monitor can be changed without
returning to the list.

The numbers are calculated from the stored check results, so a range cannot reach back further than
`MONITOR_RESULT_RETENTION_DAYS`; the page says so when it is clamped. The same data is available as
`GET /api/v1/admin/monitors/:id/stats?hours=168`.

---

## HTTPS

| Field | Default | What it does |
| --- | --- | --- |
| **URL** | `https://` | The address to request. Plain `http://` works too. Required. |
| **Method** | `GET` | `GET`, `POST` or `HEAD`. |
| **Expected Status** | `200` | The exact status code the final response must have. Anything else is **Down**. |
| **Keyword (optional)** | — | Text the response body must contain. Case-sensitive. Missing → **Degraded**. |

Redirects are followed, and the expected status is compared with the last response. The
response time is measured until the response headers arrive, before the body is read for the
keyword. It is recorded and charted, but no response time makes a check fail.

**Request** tab:

- **Request Headers** — any number of name/value pairs sent with every check. Headers set by
  authentication (`Authorization`) take precedence over a custom header with the same name.
- **Request Body (JSON)** — sent as-is. No `Content-Type` is added for you, so add
  `Content-Type: application/json` as a header if the endpoint needs it. Use a body only with
  `POST`; leave it empty for `GET` and `HEAD`.

For `https://` URLs the form also offers [certificate expiry warnings](#tls-certificate-expiry-warnings).

---

## HTTPS authentication

Open the **Auth** tab and pick a scheme. The same code authenticates the scheduled check and the
**Test** button, and the monitor's timeout covers the whole exchange, token requests included.

| Scheme | Fields | What happens on each check |
| --- | --- | --- |
| **None** | — | The request is sent as configured. |
| **Basic** | Username, Password | An `Authorization: Basic …` header is added. |
| **OAuth2** | Token URL, Scope (optional), Client ID, Client Secret | A fresh token is requested, then sent as `Authorization: Bearer …`. |
| **CAS** | CAS Server URL, Username, Password | A CAS ticket is obtained and the service is requested with it. |

### OAuth2

OAuth2 uses the **client credentials** grant. Each check `POST`s `grant_type=client_credentials`,
`client_id`, `client_secret` and, if set, `scope` as a form to the **Token URL**. The response must
be JSON with an `access_token`. A token request that fails, or a response without a token, makes the
check **Down**.

### CAS

CAS uses the CAS REST protocol. On each check:

1. Username and password are `POST`ed to `<CAS Server URL>/v1/tickets` to get a ticket-granting
   ticket. Bad credentials fail here.
2. The monitored URL is requested without following redirects, collecting session cookies, to find
   the exact service URL CAS expects (the `service` parameter of the redirect to CAS). If none is
   found, the configured URL is used.
3. A service ticket is requested for that service URL.
4. The service URL is requested with `?ticket=…`, then the monitored URL with the collected
   cookies. If the application redirects to the CAS login again, a second ticket is obtained for it
   automatically.

**CAS Server URL** is the base of your CAS server, for example `https://cas.example.com/cas`.

### Credentials from the vault

Every credential block — Basic, OAuth2, CAS and the SQL databases — has a **Direct input / From Vault**
switch. Direct input stores the values in the monitor. **From Vault** references a secret from the
[vault](vault.md) instead; when a secret is set, it overrides any direct values.

| Secret type | Basic / CAS | OAuth2 | SQL databases |
| --- | --- | --- | --- |
| **userpass** | username, password | username → Client ID, password → Client Secret | username, password |
| **value** | used as the password | used as the Client Secret | used as the password |
| **json** | pick the JSON key for each field | pick the JSON key for each field | pick the JSON key for each field |

For a **json** secret, the form shows a **JSON Field Mapping**: type the key in the JSON object that
holds each value.

---

## Ping / TCP

| Field | Default | What it does |
| --- | --- | --- |
| **Host** | — | Host name or IP address. Required. |
| **Mode** | `TCP` | `TCP` opens a connection to the port. `ICMP` sends a ping. |
| **Port** | `80` | The port for TCP mode. Ignored in ICMP mode. |

**TCP** is up as soon as the connection is accepted; the time to connect is the response time.
**ICMP** runs the server's system `ping` command with the timeout rounded up to whole seconds.
Prefer TCP when the host or a firewall drops ICMP.

---

## DNS

| Field | Default | What it does |
| --- | --- | --- |
| **Hostname** | — | The name to look up. Required. |
| **Record Type** | `A` | `A`, `AAAA`, `MX`, `CNAME` or `TXT`. |
| **Expected Value** | — | Text that must appear in at least one returned record. Missing → **Degraded**. |
| **Custom Resolver (optional)** | — | IP address of the DNS server to ask, for example `8.8.8.8`. Empty uses the server's own resolvers. |

The expected value is matched as a substring, so `1.2.3` matches `1.2.3.4`. For `MX` it is compared
with the mail server names; for `TXT` with each record, its chunks joined together. Without an
expected value, the check only requires that the lookup returns records.

---

## Docker

Checks one container through the Docker Engine API. Only read access is used: the monitor inspects
the container and never starts, stops or changes anything.

- **Docker endpoint** — where the API is reachable:
  - `unix:///var/run/docker.sock` — the local socket (default). When BetterStatusPage itself runs in
    a container, the socket has to be mounted into it. Access to the socket is equivalent to root
    access on the host, so prefer a socket proxy that only allows read requests.
  - `npipe:////./pipe/docker_engine` — the named pipe of Docker on Windows.
  - `http://host:2375` or `https://host:2376` — the API of a remote host. Client certificates are
    not supported, so expose it only on a trusted network or behind a proxy.
- **Container name or ID** — as shown by `docker ps`: letters, digits, `_`, `.` and `-`.

The endpoint is validated when you save the monitor. HTTP(S) endpoints must be just scheme, host and
port; a path, query or credentials are rejected, and so is a remote `npipe://` host. A socket
endpoint reaches any socket the BetterStatusPage process can open, so only trusted administrators
and operators should create Docker monitors.

A container stuck in a crash loop alternates between restarting (**Degraded**) and stopped
(**Down**). Set the monitor's retries or failure threshold with that in mind.

| Container | Result |
| --- | --- |
| Running, healthy or without a healthcheck | **Operational** |
| Running, healthcheck `unhealthy` or `starting`, or restarting | **Degraded** |
| Stopped, paused or not found; the API does not answer | **Down** |

---

## SQL Server, PostgreSQL, MySQL / MariaDB and MongoDB

In the monitor form these are one **Database** type: pick the **Engine** inside it. Switching the engine keeps what you typed and changes the port only while it still holds the previous default. The engines share one check; only the driver, the default port and the test query differ.

| Type | Default port | Notes |
| --- | --- | --- |
| **SQL Server** | `1433` | |
| **PostgreSQL** | `5432` | |
| **MySQL / MariaDB** | `3306` | One type for both servers: they speak the same protocol |
| **MongoDB** | `27017` | The test is a command, not SQL; see below |

Choose how to connect:

- **Individual fields** — **Host**, **Port** (default per type, see above), **Database**, and
  **User** / **Password** typed in or taken from the vault. The connection is encrypted and the
  server certificate is not verified. PostgreSQL and MySQL / MariaDB fall back to an unencrypted
  connection when the server has no TLS; SQL Server always encrypts. MongoDB connects without TLS
  and signs in against the given database (`admin` when empty); use a connection string for TLS or
  another `authSource`.
- **Connection string** — a full connection string, which must come from the vault: a **value**
  secret, or a **json** secret with the key that holds the string. A **userpass** secret cannot be
  used here. TLS and certificate checks are then governed by the string itself (for MongoDB `tls=true` and `authSource`; for PostgreSQL
  `sslmode`, where `require` verifies the certificate and `no-verify` does not; for MySQL / MariaDB a
  `mysql://` URI, encrypted only with an `ssl` parameter). Use it when you need a verified certificate.

**Test Query** (default `SELECT 1`) runs on every check. A connection error, query error or timeout
makes the check **Down**.

For MongoDB the field is **Test Command (JSON)**, a database command such as `{"ping":1}` (the
default) or `{"dbStats":1}`. The first field of the reply is the value that `expectedResult`
compares. Use a user that can only read: the command runs as given.

**Expected Result** (optional): the first column of the first row, as text, must equal it exactly,
or the check is **Degraded**. Leave it empty to accept any result. In the API it is the
`expectedResult` field of the monitor config.

Example: a job queue where tasks sometimes get stuck. Set **Test Query** to
`SELECT COUNT(*) FROM queue WHERE stuck = 1` and **Expected Result** to `0`.

| Query returns | Check |
|---|---|
| `0` | **Operational** |
| `3` | **Degraded**: `Expected "0", got "3"` |
| connection error, query error or timeout | **Down**, whatever the expected result |

The comparison is on text, so `0` does not match `0.0` or ` 0`.

```http
PATCH /api/v1/admin/monitors/:id
{ "config": { ..., "query": "SELECT COUNT(*) FROM queue WHERE stuck = 1", "expectedResult": "0" } }
```

`config` is replaced as a whole, so send the complete object.

---

## Webhook (passive heartbeat)

A webhook monitor turns the check around: instead of BetterStatusPage calling your service, your
service — a cron job, a backup script, a worker — calls BetterStatusPage. Each call says "I am
alive". Silence means trouble.

### The URL

A unique URL is generated when you save the monitor. The form stays open after **Create Monitor**
so you can copy it:

```
https://<your-bsp-host>/api/v1/hook/<token>
```

The token is 48 hexadecimal characters. Anyone who knows the URL can mark the monitor up, so treat
it like a password. **Reset token** (when editing) generates a new one; the old URL stops working at
once.

### Sending a heartbeat

Send a `GET` or a `POST`. The request body and headers are ignored. A valid token answers `200` with
`{"ok":true}`; an unknown token answers `404`. Each URL accepts up to 60 requests a minute.

```bash
curl -fsS https://status.example.com/api/v1/hook/<token>
```

Ping only when the job actually succeeded:

```cron
# Nightly backup at 02:00, heartbeat only if it worked
0 2 * * * /usr/local/bin/backup.sh && curl -fsS -m 10 https://status.example.com/api/v1/hook/<token> > /dev/null
```

### How silence is detected

Each heartbeat records one successful check. If no heartbeat arrives for one full **Interval**,
the monitor records a failed check — *No webhook received within interval* — and goes **Down**.
While the silence lasts, it records another failed check every interval.

A new monitor gets one full interval from its creation before it can go down.

There is no separate grace period. Set the interval a little longer than the time between your
job's runs — for an hourly job, `3900` seconds (65 minutes) — or use **Alert after (checks)** to
require several missed intervals before anyone is paged. **Timeout** and **Attempts** do not apply
to webhook monitors.

---

## TLS certificate expiry warnings

*Admin → Monitors → edit an HTTPS monitor → **Warn before the TLS certificate expires***

The option appears once the URL starts with `https://`.

| Field | Default | Range |
| --- | --- | --- |
| **Warn days before expiry** | `14` | `1–365` |

The monitor's channels get one warning when the certificate enters that window, then a reminder
7, 3 and 1 days before it expires — only the reminders shorter than your lead time. With the
default of 14, that is warnings at 14, 7, 3 and 1 days. Each step is sent once. If the certificate
is already deep inside the window when you switch warnings on, you get one warning for the nearest
step, not a burst of them.

When a certificate you were warned about is replaced by one that expires later, the channels get an
all-clear — if the channel sends recovery notifications.

How it behaves:

- The certificate is read over a separate connection after a check, at most every 6 hours. A
  failed read is retried after 15 minutes and keeps the last known expiry.
- Changing the monitor's settings makes the next check read the certificate again. Changing the URL
  forgets what was known about the old certificate.
- Warnings never change the monitor's status, and the public page is not affected. A certificate
  that has **already expired** fails the check itself, so the monitor goes **Down** and alerts as
  usual.
- Certificate notifications go through the channel's [alert hygiene](alert-hygiene.md) rules like
  any other event.
- The monitor list shows *TLS certificate: N days left* under each HTTPS monitor whose certificate
  has been read, tinted once inside the warning window.

Certificate notifications add these [template variables](notification-channels.md):

| Variable | Value |
| --- | --- |
| `{{event_type}}` | `certificate` |
| `{{status}}` | `cert-expiring` or `cert-renewed` |
| `{{cert_host}}` | The host the certificate was read from |
| `{{cert_expires_at}}` | Expiry as an ISO 8601 timestamp |
| `{{cert_expires_in}}` | `in 5 days`, `in 1 day` or `in less than a day` |
| `{{cert_days_left}}` | Whole days left, rounded down |

`{{error_message}}` carries a one-line summary, for example
*TLS certificate for example.com expires in 7 days (2026-10-10T12:00:00.000Z)*.

---

## Dependencies

*Admin → Monitors → edit a monitor → **Depends on***

When a shared component fails — a database, a gateway, a DNS server — every service behind it fails
too. Dependencies keep that to one alert.

Tick the monitors this one depends on. On each check, if any of them is currently **Down**,
**Degraded** or **Dependency Issue**, this monitor is recorded as **Dependency Issue** instead of its
own result.

- **Dependency Issue does not alert.** The upstream monitor sends the only alert.
- When this monitor comes back up from **Dependency Issue**, no recovery is sent — unless it had
  already alerted on its own before its dependency failed. That alert is still open and gets its
  all-clear.
- On the public page the monitor shows **Dependency Issue** with a **Caused by** chip naming its
  dependencies that are on the page. In the admin list the badge reads **Dep. Issue**.
- A monitor cannot depend on itself, and a loop (A depends on B, B depends on A) is rejected when you
  save.

Webhook heartbeats always record the monitor as up; dependencies only apply when the monitor's
interval passes without one.

---

## Saved secrets

> [!WARNING]
> **Not released yet.** This feature is only in the `main` branch; build the image yourself from the `main` branch (see [Deployment](deployment.md)).

A saved password, OAuth2 client secret, database password and credential header are never shown again, in the form or in the API.
A header counts as a credential when its name contains `auth`, `token`, `secret`, `key`, `pass`, `pwd`, `credential`, `cookie`, `session` or `signature` (so `Authorization`, `Cookie` and `X-Api-Key` do).
A secret reads back as `••••••••`. Leave the field untouched to keep the stored value, or type a new one to replace it.
A secret read from a [vault](vault.md) is a reference, not a secret, and is shown as such.

A stored secret is only kept while it is sent to the same place. If you change the **URL**, the OAuth2 token URL, the CAS server, or a database **host** or **port** while a secret still shows as `••••••••`, saving is refused with a message asking you to enter the secrets again, so a saved password cannot be redirected to a new address. A **Test** run with such a change is refused the same way. Do not write credentials into a URL or request body: only the authentication fields and headers are masked.

---

## Testing a monitor

The **Test** button in the form runs the check once with the settings in the form, without saving
them. It is available for HTTPS, Ping / TCP, DNS, the SQL databases and Docker; a webhook can only be tested by
calling its URL.

The result lists each step with its duration — authentication, every redirect, the response status,
the keyword, the query, the DNS answer — and the step that failed. For HTTPS URLs it also shows when
the TLS certificate expires and whether that is inside the warning window. **report** downloads the
full log as a text file, including the informational steps hidden in the panel, such as each CAS
probe hop.

Secrets stay out of the result: the response body is reported by size only, and cookie values are
replaced with `[redacted]`.

When you edit a saved monitor, a password, client secret or credential header that you did not change
is tested as stored, even though the form only shows it as `••••••••`.

The test uses the form's **Timeout**, limited to between 0.5 and 60 seconds. Unlike a scheduled
check, a missing keyword or a mismatched result is shown as a failed test, not as degraded.

---

## Showing a monitor on the status page

A monitor is public only once you place it on the status page — as a status card or a chart — in
the Page Builder. Until then it is internal: its name, status and history never appear on the public
page, in the public status API, in subscriber options or in the "Caused by" chip. See
[Customizing the status page](customizing-the-status-page.md).

Checks keep running during a maintenance window and the status page shows reality, but the monitor
sends no notifications. An outage that is still going on when the window ends alerts then. See
[Incidents and maintenance](incidents-and-maintenance.md).
