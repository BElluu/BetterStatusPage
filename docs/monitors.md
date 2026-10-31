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
| **Oracle** | A query against Oracle Database | Connection or query error, timeout | The first value returned does not match |
| **Redis** | PING, after AUTH when a password is set | The connection, the sign-in or the PING fails | — |
| **Mail server** | SMTP, IMAP or POP3 greeting, STARTTLS and, optionally, sign-in | The connection, the greeting, the encryption or the sign-in fails | — |
| **SSH** | The identification string of an SSH server | The port does not answer with an SSH banner, or the banner does not match | — |
| **TLS certificate** | The certificate of any TLS port | Expired, not trusted (with verification on), wrong name or handshake error | It expires within the warning window |
| **Domain expiry** | When a domain registration ends | The registration has expired or the lookup fails | It ends within the warning window |
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
| **Interval (s)** | `60` | How often the check runs. `10`–`86400`. For a webhook monitor, how long silence may last,. |
| **Timeout (ms)** | `10000` | How long one attempt may take, authentication and redirects included. `1000`–`300000`. |
| **Attempts** | `1` | How many times one check is tried before it counts as down. `1–10`. |
| **Alert after (checks)** | `1` | Consecutive failed checks before an alert is sent. `1–20`. |
| **Recover after (checks)** | `1` | Consecutive successful checks before a recovery is sent. `1–20`. |

A few details:

- **Attempts** are retried right away, inside the same check, and only when the result is *down*.
  A degraded result is not retried. The check counts as down only if every attempt fails.
- **Alert after / Recover after** do not delay the status page, only notifications. See
  [Failure and recovery thresholds](alert-hygiene.md#failure-and-recovery-thresholds).
- The **Incident** side tab opens an incident when the monitor stays down
  for the minutes you set. See [Automatic incidents](incidents-and-maintenance.md#automatic-incidents).
- The scheduler wakes every 10 seconds (`SCHEDULER_TICK_SECONDS`), so a check runs at most that
  long after its interval has passed. At most `MONITOR_CHECK_CONCURRENCY` scheduled checks (default 20)
  run at the same time; when more are due, the rest wait their turn, so a few hanging monitors do not
  hold up the others for long, but enough of them can delay checks. See [Performance](performance.md#checks).

The side tabs of the form hold the rest:

| Tab | Shown for | What it holds |
| --- | --- | --- |
| **Auth** | HTTPS | [Authentication](#https-authentication) |
| **Request** | HTTPS | Custom headers and request body |
| **Tags** | All | Coloured labels |
| **Alerts** | All | The [notification channels](notification-channels.md) this monitor alerts on |
| **Actions** | All, administrators only | The [actions](actions.md) this monitor runs when it stays down or comes back up |
| **Depends on** | All | [Dependencies](#dependencies) |
| **Incident** | All | [Automatic incidents](incidents-and-maintenance.md#automatic-incidents) |

### What is checked when you save

The configuration of a monitor is checked when it is created, changed, imported from [YAML](configuration-as-code.md), sent with the [API](api.md) or run with **Test**, and a wrong one is refused with a message that names the field. A monitor that is already saved is checked again only when it is changed or imported again.

| Type | Required | Also checked |
| --- | --- | --- |
| HTTPS | `url`: a full `http://` or `https://` address, without spaces or a user name and password, up to 2048 characters | `method` is `GET`, `POST` or `HEAD` (any case); `expectedStatus` is 200 to 599, the final status after redirects; the [response checks](#response-checks) |
| Ping / TCP | `host` | `mode` is `tcp` or `icmp` (tcp when absent); `port` is 1 to 65535 for tcp (80 when absent) |
| DNS | `hostname` | `recordType` is `A`, `AAAA`, `MX`, `CNAME` or `TXT` (A when absent) |
| SQL Server, PostgreSQL, MySQL / MariaDB, MongoDB, Oracle | `host`, unless the connection string comes from a vault secret (`mode: connectionString`) | `port` is 1 to 65535 (the usual one of the engine when absent); `mode`, `tls` and `tlsCa` |
| Redis, mail, SSH, TLS certificate, domain, Docker | what the form asks for | lengths, ports, choices and `warnDays` |

Fields the table does not name are not checked: the check reports a wrong value when it runs.

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

Click a monitor's name in the monitor list, or its tile under **System Components** on the
**Dashboard**, to open its page (`/admin/monitors/:id`); **Monitors** above the title leads back to
the list. The page shows the monitor over the last 24 hours, 7 days, 30 days or 90 days, up to the result retention:

- **Response time** chart, drawn like the one on the status page: average, p95 or maximum per
  period, with down and degraded periods shaded and a tooltip per point. Beside it: average,
  fastest, slowest, p50, p95 and p99, and the usual p95 of the monitor's previous 7 days once
  it has a day of history. The p95 view of the chart draws that usual p95 as a dashed line, and
  the limit of the [slower-than-usual alert](#slower-than-usual-alert) when it is on.
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
| **Bypass caches** | off | Adds a random `bsp_cachebuster` query parameter to the request. See [Bypassing caches](#bypassing-caches). |

The **Checks** tab on the right of the form adds what the response must contain besides its status:

| Field | Default | What it does |
| --- | --- | --- |
| **Keyword (optional)** | — | Text the response body must contain. Case-sensitive. Only the first 1 MB of the body is searched. Missing → **Degraded**. |
| **Degraded when slower than** | — | A response time over this many milliseconds makes the check **Degraded**. |
| **Response checks** | — | Headers and JSON fields, see [Response checks](#response-checks). |

Redirects are followed, and the expected status is compared with the last response. A redirect to another origin carries only `Accept`, `Accept-Language`, `Accept-Encoding`, `User-Agent` and `Cache-Control` from your headers, and no request body (a `307`/`308` is sent there as a plain `GET`); the upgrade of an `http://` URL to `https://` on the same host and default port is not leaving the monitor, so it keeps them. CAS session cookies go only to the host that set them (and the subdomains of its `Domain`), and `Secure` ones only over HTTPS. The OAuth2 token request is never redirected: set the token URL to its final address. The
response time is measured until the response headers arrive, before the body is read. It is
recorded and charted; it only changes the status when **Degraded when slower than** is set.

### Bypassing caches

A CDN or reverse proxy in front of the endpoint may answer a `GET` from its cache, so the check passes while the backend is down. With **Bypass caches** on
(`cacheBuster: true` in the monitor's `config`), every check adds a query parameter named `bsp_cachebuster` with a new random value (16 hexadecimal characters)
to the URL of the request, so a cache that keys on the URL has no stored answer for it. The name is fixed, which lets you recognise
these requests in server logs or leave them out of cache rules.

- It applies to `GET` and `HEAD`; the option is hidden for `POST`, which caches do not store this way.
- It is added to the first request only. A redirect is followed to the address the server gives, and the **Test** result shows the URL that was requested.
- It is not used with CAS authentication, which signs the exact address of the endpoint.
- Leave it off for an endpoint that rejects unknown parameters, such as a signed URL. A cache that ignores the query string is not bypassed; in that case send a `Cache-Control: no-cache` header from the **Request** tab as well.

### Where a monitor may connect

A monitor requests the address you give it, and a failed response check or a test shows something
of the answer, so a URL must not be able to read the credentials of the host the server runs on.
HTTPS monitors, the test runner, the certificate reading, HTTP actions, Docker monitors on a TCP endpoint, the Redis, mail server, SSH and TLS certificate monitors, and the notification channels that call an address you typed (webhook, Slack, Discord, Teams and an ntfy server of your own) therefore refuse to
connect to cloud metadata services: the link-local range `169.254.0.0/16` (AWS, GCP, Azure and others),
`fe80::/10`, `fd00:ec2::254`, `fd20:ce::254`, `100.100.100.200` and `metadata.google.internal`. The address that is
actually connected to is checked, so a redirect, a host name that resolves to such an address or a
DNS answer that changes between checks does not get around it.

Private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) and `localhost` stay reachable, since
watching internal services is what a self-hosted status page is for. If the server runs on a host
where a monitor has to read a metadata service, set `MONITOR_ALLOW_METADATA=true`. Ping / TCP, DNS and the
database monitors are not affected: they connect to the host you name and show nothing of what it answers.

### Outbound proxy

HTTPS monitor checks and the **Test** button go through a proxy when the server is started with the standard
`HTTP_PROXY` and `HTTPS_PROXY` environment variables (`http://proxy.example:3128`, optionally with
`user:password@`), for networks that require outbound traffic to pass a proxy. `http://` addresses go to
`HTTP_PROXY` as ordinary proxy requests and `https://` addresses are tunnelled through `HTTPS_PROXY` (with `CONNECT`);
when only `HTTP_PROXY` is set, it serves both. The lower-case names (`http_proxy`, `https_proxy`, `no_proxy`) win over the
upper-case ones when both are set. `NO_PROXY` lists hosts that are reached directly: comma-separated, a leading dot or `*.` covers
subdomains, `host:port` limits an entry to a port, an IPv6 address is written in brackets (`[::1]`), CIDR ranges are not understood,
and `*` as the whole value turns the proxy off. `HTTP_PROXY` and `HTTPS_PROXY` are read when the server starts, so a change needs a
restart; `NO_PROXY` is read at every request. When the proxy refuses a request or cannot be reached, the check and the test
show the reason (for example `Proxy response (407) !== 200 when HTTP Tunneling`) instead of a bare `fetch failed`.

The proxy opens the connection and resolves the host name, so the address check above is made on the host in the URL
(and in every redirect) and not on the address it resolves to: the addresses and the names metadata services answer to
are refused, but a name that merely resolves to one is not. Make the proxy itself refuse `169.254.0.0/16`,
`fd00:ec2::254` and `100.100.100.200` if it runs on a cloud host.

Only HTTPS monitors and the test runner use the proxy. Reading the certificate (the expiry warning of a monitor and the
certificate step of the test), the other monitor types, HTTP actions and notification channels still connect directly, so
on a network that only allows traffic through the proxy the expiry warning cannot be read. A monitor that sets its own
`Proxy-Authorization` header fails while a proxy is configured.

### Response checks

Beyond the status code and the keyword, a monitor can check the **headers** and the **JSON body** of
the final response (after redirects). Add them in the **Checks** tab on the right of the form (next to the keyword and the slow-response limit); each check
has its own result when it fails, **Degraded** or **Down**.

| Check | Conditions |
| --- | --- |
| **Header** | exists, does not exist, equals, does not equal, contains |
| **JSON** | exists, equals, does not equal, contains, is less than, is greater than |

- A header name is matched without regard to case; its value is compared as text, so
  `X-Replicas` **equals** `2` is true for `X-Replicas: 2`. A missing header fails every
  condition except **does not exist** and **does not equal**.
- A JSON check names a field with a path: `$.status`, `$.queue.length`, `$.items[0].id` or
  `$['odd key']`. **exists** is true for a field holding `null` too. **equals** compares numbers,
  strings and booleans as text (`true`, `150`); **contains** looks for a substring in a string
  or an element in a list; **is less than** and **is greater than** need a numeric field.
  Wildcards and filters are not supported.
- The body is read only when a JSON check needs it. A body that is not JSON, or larger than
  1 MB, fails every JSON check instead of the monitor erroring out.
- All failed checks are listed in the error, and the worst result wins: one **Down** check makes
  the monitor Down even if others are only Degraded. Checks do not run when the status code
  is already wrong.
- At most 20 checks per monitor. When a failed check names a header holding a credential
  (`Set-Cookie`, `Cookie`, `Authorization`), the error says the header is present but not what it held.

In YAML and the API they are `assertions` and `degradedAboveMs` in the monitor's `config`:

```yaml
config:
  url: https://api.example.com/status
  expectedStatus: 200
  degradedAboveMs: 2000
  assertions:
    - { type: header, name: X-Replicas, op: equals, value: "2", onFail: down }
    - { type: json, path: $.queue.length, op: lt, value: 100 }   # onFail defaults to degraded
```

**Request** tab:

- **Request Headers** — any number of name/value pairs sent with every check. Headers set by
  authentication (`Authorization`) take precedence over a custom header with the same name.
- **Request Body (JSON)** — sent as-is. No `Content-Type` is added for you, so add
  `Content-Type: application/json` as a header if the endpoint needs it. Use a body only with
  `POST`; leave it empty for `GET` and `HEAD`.

For `https://` URLs the form also offers [certificate expiry warnings](#tls-certificate-expiry-warnings)
and [Ignore TLS certificate errors](#ignore-tls-certificate-errors).

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

**ICMP in a container.** The server runs as an unprivileged user, so the host kernel must allow
unprivileged ICMP (`net.ipv4.ping_group_range`). Docker sets a permissive range by default, but some
hosts and hardened runtimes restrict it. Then every ICMP check fails with *ICMP is not permitted for
the server process*, even though the target is up. Allow it for the container, for example in
`docker-compose.yml`:

```yaml
sysctls:
  net.ipv4.ping_group_range: "0 2147483647"
```

Granting `NET_RAW` (`cap_add`) does not help while the container runs as a non-root user. The image
uses BusyBox `ping`; a custom image or bare-metal host needs a `ping` command installed (for example
`iputils-ping`), otherwise the error is *The ping command could not be run on the server*.

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

## SQL Server, PostgreSQL, MySQL / MariaDB, MongoDB and Oracle

In the monitor form these are one **Database** type: pick the **Engine** inside it. Switching the engine keeps what you typed and changes the port only while it still holds the previous default. The engines share one check; only the driver, the default port and the test query differ.

| Type | Default port | Notes |
| --- | --- | --- |
| **SQL Server** | `1433` | |
| **PostgreSQL** | `5432` | |
| **MySQL / MariaDB** | `3306` | One type for both servers: they speak the same protocol |
| **MongoDB** | `27017` | The test is a command, not SQL; see below |
| **Oracle** | `1521` | **Service name** instead of Database (for example `FREEPDB1`); the test query is `SELECT 1 FROM DUAL`, without a trailing `;` |

Choose how to connect. The sign-in itself (user and password, or the Vault secret with the connection string) is set on the **Credentials** tab at the side of the form, which opens by itself when you choose the Database type; a database monitor cannot be saved without credentials.


- **Individual fields** — **Host**, **Port** (default per type, see above), **Database**, and
  **User** / **Password** typed in or taken from the vault, and **Connection security** (see below).
  MongoDB signs in against the given database (`admin` when empty); use a connection string for
  another `authSource`.
- **Connection string** — a full connection string, which must come from the vault: a **value**
  secret, or a **json** secret with the key that holds the string. A **userpass** secret cannot be
  used here. TLS and certificate checks are then governed by the string itself (for MongoDB `tls=true` and `authSource`; for PostgreSQL
  `sslmode`, where `require` verifies the certificate and `no-verify` does not; for MySQL / MariaDB a
  `mysql://` URI, encrypted only with an `ssl` parameter; for Oracle `user/password@host:port/service_name`, a `tcps://` address for TLS, or a full connect descriptor after the `@`, and the password ends at the first `@`). Use it when you need a verified certificate.

### Connection security

In individual-fields mode the **Connection security** setting (`tls` in the monitor's `config`) decides how the password is protected:

| Setting | `tls` | Behaviour |
| --- | --- | --- |
| **Encrypted, verify certificate** | `verify` | Encrypted, and the server certificate and host name must be valid. Paste the certificate of your own authority into **CA certificate** (`tlsCa`) when the server uses one; empty means the public CAs bundled with Node.js (plus `NODE_EXTRA_CA_CERTS`); a pasted CA replaces them. The form starts new monitors here. |
| **Encrypted, certificate not checked** | `require` | Encrypted, no plain-text fallback, but anyone on the network path can pose as the server. |
| **Encrypted if available, certificate not checked** | `prefer` | The behaviour of monitors created before the setting existed: PostgreSQL and MySQL / MariaDB fall back to plain text when the server answers that it has no TLS, so a party on the network path can read the password. SQL Server encrypts without checking the certificate. MongoDB is not encrypted at all. Monitors without `tls` use it. |

Oracle is connected with the pure JavaScript driver, which always verifies the certificate: there is no **Encrypted, certificate not checked** choice for it (a monitor with `require` fails with a message saying so), `prefer` connects without encryption, and `verify` uses TLS (`tcps`) with the CA you paste, or the CAs bundled with Node.js. The server needs a TCPS listener for that.

Monitors created through the API or a configuration file without `tls` use `prefer`. `verify` matches the host name against the certificate, so connect by DNS name: MySQL / MariaDB and SQL Server cannot verify a server addressed by IP. Change existing monitors to `verify` (or at least `require`). A connection string keeps its own TLS settings, as described above.

The monitor runs the query or command as written, so give it an account that can only read.

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

## Redis

Connects to a Redis server (or a compatible one such as Valkey or KeyDB), signs in when a password is set and sends `PING`. It reads and writes no data.

| Field | Default | What it does |
| --- | --- | --- |
| **Host** | — | Name or address of the server. Required. |
| **Port** | `6379` | |
| **Connect over TLS** | off | Encrypts the connection from the first byte. |
| **Verify the server certificate and host name** | on | With TLS on. Turn it off only for servers you trust. |
| **CA certificate (PEM, optional)** | — | For a certificate signed by your own authority. Empty uses the CAs bundled with Node.js. |

The **Credentials** tab holds the account. A password alone signs in as the default user; a user name and password
sign in as a Redis ACL user. Either can come from a [Vault](vault.md) secret (its `username` or `user`
and `password` or `value` keys). A server without a password needs no credentials.

Once saved, the password is shown as `••••••••`. Changing the host, the port, the CA certificate or turning TLS or certificate verification off
makes the server refuse to keep it, so a stored password can never be redirected or sent with weaker protection: type it again to confirm the change.

The monitor is **Down** when the connection, the sign-in or the `PING` fails; the message is the one Redis sent, for
example `WRONGPASS invalid username-password pair` or `NOAUTH Authentication required.`. It is never **Degraded**.

---

## Mail server

Checks an SMTP, IMAP or POP3 server. Without an account it proves the server answers with its greeting; with one it
also proves that signing in works. No mail is sent, listed or read.

| Field | Default | What it does |
| --- | --- | --- |
| **Protocol** | SMTP | SMTP, IMAP or POP3. |
| **Encryption** | STARTTLS | **TLS from the start** (SMTPS, IMAPS, POP3S), **STARTTLS** (upgrade after the greeting) or **None**. |
| **Host** | — | Name or address of the server. Required. |
| **Port** | follows the choices above | Until you type your own, the port changes with the protocol and encryption. |
| **Verify the server certificate and host name** | on | Unless encryption is **None**. |
| **CA certificate (PEM, optional)** | — | For a certificate signed by your own authority. Empty uses the CAs bundled with Node.js. |

| | None | STARTTLS | TLS from the start |
| --- | --- | --- | --- |
| **SMTP** | 25 | 587 | 465 |
| **IMAP** | 143 | 143 | 993 |
| **POP3** | 110 | 110 | 995 |

What the check does:

- **SMTP**: reads the `220` greeting and says `EHLO`; with STARTTLS it requires the server to offer it, upgrades and says `EHLO` again; with an account it signs in with `AUTH PLAIN` and expects `235`; then `QUIT`.
- **IMAP**: reads the `* OK` greeting; with STARTTLS it upgrades; with an account it runs `LOGIN` and then `LOGOUT`.
- **POP3**: reads the `+OK` greeting; with STARTTLS it sends `STLS`; with an account it sends `USER` and `PASS`, then `QUIT`.

The account is set in the **Credentials** tab, typed or from a [Vault](vault.md) secret, like for Redis (and with the same rule for a saved password: changing the host, port, CA certificate or encryption needs it typed again). With **None** the account is sent unencrypted, and the form warns about it. A user name or
password that contains a line break is refused, so it can never add commands to the conversation. SMTP sign-in needs
`AUTH PLAIN`, so use it over TLS or STARTTLS; a server that offers only other methods fails with `does not offer AUTH PLAIN`.
For an account with two-step verification, use an app password.

The monitor is **Down** when the connection, the greeting, the encryption or the sign-in fails; the message is the server's
reply. It is never **Degraded**.

> [!NOTE]
> Many servers slow down or block an address after repeated failed sign-ins. A wrong password checked every minute can get the status page's address
> blocked. Use the account's real password and run **Test** once before saving.

---

## SSH

Connects to an SSH port and reads the identification string the server sends first, for example `SSH-2.0-OpenSSH_9.6`.
No login is attempted, so no key or password is needed and nothing shows up in the server's authentication log.

| Field | Default | What it does |
| --- | --- | --- |
| **Host** | — | Name or address of the server. Required. |
| **Port** | `22` | |
| **Expected identification text (optional)** | — | Text the identification string must contain, for example `OpenSSH`. A different one → **Down**. |

The monitor answers with its own identification string, `SSH-2.0-BetterStatusPage`, and closes the connection, so the server does not log
a dropped handshake on every check. A service that does not send an `SSH-` line (up to 20 lines before it are tolerated) within the timeout is **Down**.

---

## TLS certificate

Connects to any service that speaks TLS from the first byte (HTTPS, IMAPS, SMTPS, LDAPS, a database with TLS) and judges the certificate it presents.
Unlike the [certificate warnings of an HTTPS monitor](#tls-certificate-expiry-warnings), which send notifications and leave the status alone, this monitor
has a status: it turns **Degraded** before the certificate expires, so the warning also shows on the status page and alerts like any other degraded monitor.

| Field | Default | What it does |
| --- | --- | --- |
| **Host** | — | Name or address of the server. Required. |
| **Port** | `443` | |
| **Host name for SNI (optional)** | the host | The name sent to the server to choose a certificate, and matched against it. Use it when you connect by address. |
| **Degraded within (days)** | `14` | 1 to 365. |
| **Verify the server certificate and host name** | on | Requires a trusted chain and a matching name. |
| **CA certificate (PEM, optional)** | — | For a certificate signed by your own authority. Empty uses the CAs bundled with Node.js. |

| Result | When |
| --- | --- |
| **Operational** | The certificate is trusted, matches the name and expires later than the warning window. The test shows the date and the days left. |
| **Degraded** | It expires within the number of days you set. |
| **Down** | It has expired; with verification on, it is not trusted, is self-signed or does not match the name; or the connection or handshake fails. |

With verification off, an untrusted or mismatched certificate is accepted, but an expired one is still **Down**. Services that upgrade
with STARTTLS are not covered here; the [mail server monitor](#mail-server) verifies the certificate during the upgrade.

---

## Domain expiry

Looks up when the registration of a domain ends and turns **Degraded** before it does, so a forgotten renewal does not take the site down.

| Field | Default | What it does |
| --- | --- | --- |
| **Domain** | — | The registered domain, such as `example.com` or `example.co.uk`. A subdomain is not found. Required. |
| **Degraded within (days)** | `30` | 1 to 365. |

The end date comes from [RDAP](https://about.rdap.org/), found through the IANA bootstrap file (`data.iana.org`). For a
top-level domain without RDAP, such as `.pl`, the monitor asks the WHOIS server that IANA names for it (port 43) and reads the expiry line. The server
therefore needs outbound access to `data.iana.org` on port 443 and, for these domains, to the registry's WHOIS server on port 43.

A domain is looked up at most once every six hours; the answer is kept in memory, so a restart looks it up again. A lookup that failed is not repeated for 30 minutes, so a registry that refuses requests is not asked at every interval. The whole lookup, including the IANA file and the WHOIS referral, shares the monitor's timeout. Registrations change rarely, so an
interval of an hour or more is plenty.

The monitor is **Down** when the registration has expired, when the domain is not registered, or when the lookup fails (no RDAP or WHOIS answer, or no expiry
date in it); the message says which. Some registries hide the expiry date from public WHOIS; for those the monitor can only report that the lookup failed.

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

The URL is shown to signed-in administrators and operators, and to an [API token](api.md#api-tokens) with `monitors:write`. A token that only reads monitors gets them without the `webhookToken` field, because the token in the URL is all it takes to report a monitor up or down.

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

### Reporting a failure

A job that ran but failed can say so at once instead of staying silent. Add two optional query
parameters:

| Parameter | Values | Meaning |
|---|---|---|
| `status` | `up` (default), `down`, `degraded` | The status to record, in lower case. An empty value means `up`. Any other value, `UP` included, answers `400`. |
| `msg` | text, at most 500 characters | The reason. Longer text is cut. Control, invisible and text-direction characters become spaces (this also splits an emoji joined with a zero-width joiner into separate emoji). It is stored as the check error and shown in the monitor details, history, alerts and the draft of an automatic incident. Ignored when `status` is `up`. |

Both are read from the query string only, also on a `POST`. Giving either one twice answers `400`.

```bash
curl -fsS "https://status.example.com/api/v1/hook/<token>?status=down&msg=backup%20failed"
```

Without parameters the call records `up`, as before. A `down` or `degraded` call is one failed
check: **Alert after (checks)**, **Recover after (checks)** and maintenance windows apply as they do
to scheduled checks. If a dependency of the monitor is down, a failing heartbeat is recorded as
**Affected**, as for a scheduled check. A heartbeat that reports `up` is always recorded as up.

### Sending by key (created on the first heartbeat)

The URL above is made when the monitor is saved, so a sender that can only be given one URL for many jobs (a backup server that notifies per datastore, say) would need a monitor created by hand for each. Heartbeats by key remove that step: the monitor is named in the URL and is created by the first heartbeat.

```
https://<your-bsp-host>/api/v1/hook/key/<key>
```

The request must carry an [API token](api.md) with the `monitors:write` permission in an `Authorization: Bearer bsp_…` header. The token goes in the header only, never in the URL. A session cookie is not accepted. A token without the permission gets `403`, whether the key exists or not.

| Answer | Meaning |
|---|---|
| `200` `{"ok":true}` | The monitor with this key exists; the heartbeat was recorded. |
| `201` `{"ok":true,"created":true}` | There was no monitor with this key; one was created and the heartbeat recorded. |
| `400` | The key cannot be used, or `status`/`msg` are wrong (as for the secret URL). Nothing is created. |
| `401` | No bearer token, or an unknown or revoked one. |
| `403` | The token lacks `monitors:write`, or it has reached its limit of created monitors (`"code":"AUTO_CREATE_LIMIT"`). |
| `429` | More than 60 requests a minute for this token and key, or more than 300 a minute for the token. |
| `409` | A monitor with this key exists but is not a webhook monitor; nothing is recorded. |

`status` and `msg` work as in [Reporting a failure](#reporting-a-failure), and are read from the query string only. Two more parameters matter only to the heartbeat that creates the monitor, and are ignored for a monitor that exists: `interval` (seconds of silence allowed, `10`–`86400`, default `86400`) and `name` (up to 200 characters, cleaned like `msg`; default the key). A wrong `interval` answers `400` on every request, creating nothing, and neither parameter may be given twice. A request body is never read, so a sender may add one of any type or size up to 64 KB. Only `GET` and `POST` are answered.

- **The key** is lower-cased and every run of characters other than letters, digits, `_` and `-` becomes `-`, so `PBS.Store1` is `pbs-store1`. A result that is empty, longer than 64 characters, or does not start with a letter or digit (`.hidden` becomes `-hidden`) is refused with `400`. Different spellings reach the same monitor: `a.b`, `a b` and `A-B` are all `a-b`. It is also the monitor's [key](configuration-as-code.md) in the API and in configuration files.
- **The new monitor** is a webhook monitor named after its key, with the interval and name you sent (24 hours and the key otherwise), and has its own secret URL like any other. It is not on the status page until you place it in the layout. It has no notification channels: link one in the admin before you rely on it to alert. Change the name, interval and thresholds there as for any monitor.
- **A limit** protects against a mistaken template creating monitors without end: one token may create 50 monitors an hour this way, counted over the last 60 minutes, so a token can set up hundreds in a few hours. Set `HEARTBEAT_AUTO_CREATE_LIMIT` to change it; `0` removes the limit. A request over the limit answers `403` and creates nothing; the sender can repeat it later. Heartbeats to existing keys are never limited by it.
- **The audit log** records each monitor created this way, with the token as the actor and its id in the entry. Heartbeats are not logged.
- **Pruning** a [configuration import](configuration-as-code.md) deletes these monitors like any other the file does not mention; the next heartbeat creates them again, without history.

#### Example: Proxmox Backup Server

In **Configuration → Notifications**, add a **Webhook** target and a matcher that sends the jobs you want to watch to it:

- **Method:** `POST`
- **URL:** `https://status.example.com/api/v1/hook/key/pbs_{{ fields.datastore }}_{{ fields.type }}`
- **Header:** `Authorization` = `Bearer {{ secrets.bsp_token }}`
- **Secret:** `bsp_token` = an API token with `monitors:write`

A heartbeat without `status` records the monitor as up, and PBS also notifies about failed jobs, so the two kinds must go to different targets. Give the first target a matcher on severity `info` and `notice` only, and a second target with the URL ending in `?status=down` a matcher on severity `error`. If the first target also received failures it would send an `up` next to the `down`, in no fixed order, and the failure could be lost. Match on the job `type` (`gc`, `prune`, `sync`, `verification`) so that notifications without a datastore do not create monitors. Check the field names against the documentation of your PBS version.

### How silence is detected

Each heartbeat without a failure status records one successful check. If no heartbeat arrives for one full **Interval**,
the monitor records a failed check — *No webhook received within interval* — and goes **Down**.
While the silence lasts, it records another failed check every interval.

A new monitor gets one full interval from its creation before it can go down.

There is no separate grace period. Set the interval a little longer than the time between your
job's runs — for an hourly job, `3900` seconds (65 minutes) — or use **Alert after (checks)** to
require several missed intervals before anyone is paged. **Timeout** and **Attempts** do not apply
to webhook monitors.

---

## Ignore TLS certificate errors

*Admin → Monitors → edit an HTTPS monitor → **Ignore TLS certificate errors***

By default an HTTPS monitor verifies the server certificate, so a device with a self-signed certificate
(a network controller on a LAN, for example) is Down. Turn this option on to accept any certificate
and still use status codes, keywords and response checks. It is off by default.

- It **disables certificate verification** for the requests to the monitored URL's host and port, and for
  the redirects to the same host and port. A redirect to another host or port, and the requests to a
  separate authentication server (OAuth 2.0 token, CAS), keep verifying the certificate, in the check and in
  the **Test** button alike. Use it only for endpoints you trust.
- It applies to `https://` URLs only; it is cleared in the form when the URL stops being `https://`.
- [Certificate expiry warnings](#tls-certificate-expiry-warnings) do not apply to a monitor that ignores
  TLS errors: the option is hidden in the form, no warnings are sent and the certificate expiry shown for
  the monitor, including the `bsp_monitor_certificate_expiry_timestamp_seconds` metric, is forgotten
  when the option is turned on. The **Test** button reports that the certificate is not verified.

In YAML and the API it is `ignoreTls: true` in the monitor's `config`:

```yaml
config:
  url: https://unifi.lan:8443/status
  ignoreTls: true
```

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

## Slower-than-usual alert

*Admin → Monitors → edit a monitor → **Latency** tab*

An endpoint can get much slower without failing a single check, so no outage alert fires. This alert compares the **p95 response time** (the time 95 % of checks stay under) of the last few checks with the monitor's own usual p95, and notifies the monitor's channels when it is several times higher. It is **off by default**.

| Field | Default | Range |
| --- | --- | --- |
| **Slower by (×)** | `3` | `1.5–10` |
| **Measured over (minutes)** | `30` | `10–240` |
| **At least slower by (ms)** | `200` | `0–60000` |
| **Confirm after (checks)** | `3` | `1–20` |

The alert fires when the p95 of the last **Measured over** minutes is at least the usual p95 times **Slower by**, **and** at least **At least slower by** milliseconds above it, for **Confirm after** checks in a row. The second condition keeps a fast endpoint from alerting on a rise nobody feels: with a usual p95 of 15 ms, 50 ms is more than 3× but only 35 ms slower. A single slow check does not move a p95 taken over a window of 21 or more checks.

The channels get a message when the monitor is back to normal once the p95 stays below the halfway point between the usual p95 and the limit for **Confirm after** checks in a row. The limit is the higher of the usual p95 times **Slower by** and the usual p95 plus **At least slower by**; at 3× with a usual p95 of 200 ms it is 600 ms, so the alert ends below 400 ms. The all-clear is sent only to channels that send recovery notifications.

How the usual p95 is measured:

- It is the p95 of the monitor's previous 7 days of checks, without the window being judged, so a slowdown does not raise its own baseline. It needs a day of history and at least 50 checks; until then nothing is judged. If check results are kept for fewer than 7 days (`MONITOR_RESULT_RETENTION_DAYS`), the history that is kept is used; keep at least 2 days, or the day of history it needs never builds up.
- It is measured again at most once an hour and **stays as it was for as long as an alert is open**, so a long slowdown does not turn into the new normal and end its own alert.
- Only checks that answered count: *Operational* and *Degraded* ones. A failed check has no response time to compare, and a monitor that stops answering is handled by [Alert after](alert-hygiene.md#failure-and-recovery-thresholds).

How it behaves:

- The window is judged after every check that answered. A window with fewer than 21 such checks says too little and is not judged, so a monitor that is checked every 15 minutes needs a longer window than 30 minutes.
- Checks during a [maintenance window](incidents-and-maintenance.md) are not judged, like every other notification.
- The alert never changes the monitor's status, the public page, [incidents](incidents-and-maintenance.md) or [actions](actions.md). The admin shows a **Slower than usual** chip next to the status (on the monitor list, the dashboard and the monitor's page) and a notice on the monitor's page, and the response time chart marks the limit and the usual p95 on its p95 view. A monitor that has an open alert and then stops answering is judged **Down** by the checks as usual.
- Changing any of the four settings, the check interval or the monitor type closes an open alert **without a notification** and measures the usual p95 again. Saving the monitor with the same values does not. Changing the target of a monitor (its URL or host) does not: the history of the old target stays in the usual p95 until it ages out (up to 7 days), so a move to a much faster or slower target can alert wrongly, or stay quiet, until then.
- Checks recorded during a maintenance window still count in the usual p95 and in the first windows after it, so a slow deploy inside a window can raise an alert shortly after the window ends.
- Notifications go to the monitor's [notification channels](notification-channels.md). [Quiet hours](alert-hygiene.md#quiet-hours) and [grouping](alert-hygiene.md#grouping-bursts-into-one-digest) apply; the [rate cap](alert-hygiene.md#rate-cap-per-monitor) counts outage alerts only, so it does not apply, as with certificate warnings. The delivery history lists them as **Slower than usual**.
- It is available for the types whose response time is the time the service took to answer: **HTTPS**, **Ping**, **DNS**, the **Database** engines, **Redis**, **Mail server** and **SSH**. **Domain expiry** and **TLS certificate** monitors time a registry lookup or a handshake, not the service, **Docker** times the local socket and **Webhook** has no response time, so they have no **Latency** tab, and the API and configuration files refuse the alert for them. Changing a monitor to one of these types turns the alert off.

The notification adds these [template variables](notification-channels.md):

| Variable | Value |
| --- | --- |
| `{{event_type}}` | `latency` |
| `{{status}}` | `latency-slow` or `latency-normal` |
| `{{latency_p95_ms}}` | The p95 of the window, in ms |
| `{{latency_baseline_ms}}` | The usual p95, in ms |
| `{{latency_ratio}}` | The first divided by the second, with one decimal, for example `3.4` |
| `{{latency_window_minutes}}` | The size of the window, in minutes |
| `{{latency_since}}` | When the alert opened, as an ISO 8601 timestamp |

`{{error_message}}` carries a one-line summary, for example *p95 response time over the last 30 minutes is 642 ms, 3.4× the baseline of 188 ms*.

In YAML it is the `latencyAlert` block of a [Monitor](configuration-as-code.md); in the API it is four fields of the monitor:

```yaml
kind: Monitor
key: checkout-api
latencyAlert:
  factor: 3
  windowMinutes: 30
  minDeltaMs: 200
  sustain: 3
```

```http
PATCH /api/v1/admin/monitors/:id
{ "latencyAlertFactor": 3, "latencyAlertWindowMinutes": 30, "latencyAlertMinDeltaMs": 200, "latencyAlertSustain": 3 }
```

`latencyAlertFactor: null` turns it off. The monitor and `GET /admin/monitors/:id/stats` also return the usual p95 (`latencyBaselineP95` on the monitor, `baselineP95Ms` in the statistics) and the monitor's `latencyAlertSince`, the time the open alert was confirmed or `null`.

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

A saved password, OAuth2 client secret, database, Redis or mail account password and credential header are never shown again, in the form or in the API.
A header counts as a credential when its name contains `auth`, `token`, `secret`, `key`, `pass`, `pwd`, `credential`, `cookie`, `session` or `signature` (so `Authorization`, `Cookie` and `X-Api-Key` do).
A secret reads back as `••••••••`. Leave the field untouched to keep the stored value, or type a new one to replace it.
A secret read from a [vault](vault.md) is a reference, not a secret, and is shown as such.

A stored secret is only kept while it is sent to the same place. If you change the **URL**, the OAuth2 token URL, the CAS server, a database, Redis or mail **host** or **port**, the **CA certificate**, the mail **Encryption**, or switch on **Ignore TLS certificate errors**, or turn off TLS or certificate verification of a Redis or mail monitor, while a secret still shows as `••••••••`, saving is refused with a message asking you to enter the secrets again, so a saved password cannot be redirected to a new address. A **Test** run with such a change is refused the same way. Do not write credentials into a URL or request body: only the authentication fields and headers are masked.

---

## Testing a monitor

The **Test** button in the form runs the check once with the settings in the form, without saving
them. It is available for every type except webhook, which can only be tested by
calling its URL.

The result lists each step with its duration — authentication, every redirect, the response status,
the keyword, each response check, the query, the DNS answer — and the step that failed. For HTTPS URLs it also shows when
the TLS certificate expires and whether that is inside the warning window. **report** downloads the
full log as a text file, including the informational steps hidden in the panel, such as each CAS
probe hop.

Secrets stay out of the result: the response body is reported by size only, and cookie values are
replaced with `[redacted]`. A failed response check names the value the endpoint answered
(`it is "2"`) only to administrators signed in with a session; for operators, API tokens and in the
messages of scheduled checks, which are stored and sent in notifications, it says `the value is not shown`.

When you edit a saved monitor, a password, client secret or credential header that you did not change
is tested as stored, even though the form only shows it as `••••••••`.

The test uses the form's **Timeout**, limited to between 0.5 and 60 seconds. Unlike a scheduled
check, a missing keyword, a failed response check, a slow response or a mismatched result is shown as a failed test, not as degraded; the step says what the scheduled check would report.

---

## Showing a monitor on the status page

A monitor is public only once you place it on the status page — as a status card or a chart — in
the Page Builder. Until then it is internal: its name, status and history never appear on the public
page, in the public status API, in subscriber options or in the "Caused by" chip. See
[Customizing the status page](customizing-the-status-page.md).

Checks keep running during a maintenance window and the status page shows reality, but the monitor
sends no notifications. An outage that is still going on when the window ends alerts then. See
[Incidents and maintenance](incidents-and-maintenance.md).
