# Changelog

All notable changes to BetterStatusPage are documented in this file.
The project follows [Semantic Versioning](https://semver.org/); while it is below 1.0, a new minor version marks new features.

## [Unreleased]

### Added

- **Heartbeat token in configuration files**: a `webhook` monitor document can carry `heartbeatToken`, so a monitor that is created again keeps the URL its senders call. The export writes the mask instead of the value, and an import without it keeps the stored token. See [Heartbeat token](configuration-as-code.md#heartbeat-token).

### Fixed

- **Status page before the setup**: opening the address of a new instance without `/admin` logged `Error: DB not initialized` and showed a broken page. It now redirects to the setup wizard until the first administrator is created.
- **ICMP ping monitors in a container**: when the host did not allow unprivileged ICMP, or the `ping` command was missing, the monitor reported a bare system message that looked like a dead target. It now says that ICMP is not permitted (or that `ping` cannot be run) and how to fix it. `docker-compose.yml` has a commented `sysctls` example and the Ping / TCP and deployment docs explain the setting.
- **`npm run db:migrate` and `npm run db:seed`**: did not work. `db:migrate` did nothing and `db:seed` failed with "DB not initialized". `db:migrate` now opens the database and applies the migrations; `db:seed` also applies them, creates the administrator and the default branding and layout, and marks the setup as done so the server skips the setup wizard. Both can be run again safely.
- **Faster `npm run dev`**: the shared packages are rebuilt only when they changed, so a start with no changes no longer spends about 12 seconds building ten packages.

## [0.4.0] - 2026-10-14

### Added

- **ntfy and Pushover notification channels**: send monitor alerts, recoveries and TLS certificate warnings as push notifications to a topic on ntfy.sh or your own ntfy server, or to a Pushover user or group. A down monitor is sent with high priority. The ntfy access token and the Pushover application token are shown only by their last four characters once saved, and can be read from the vault. The API and configuration files gain the `ntfy` (`topic`, `serverUrl`, `accessToken`) and `pushover` (`appToken`, `userKey`) channel types. See [ntfy and Pushover](notification-channels.md#ntfy-and-pushover).
- **HTTPS response checks and slow-response limit**: an HTTPS monitor can check the headers of the final response (exists, does not exist, equals, does not equal, contains) and fields of a JSON body by path such as `$.queue.length` (exists, equals, does not equal, contains, less than, greater than), each failing as **Degraded** or **Down**, and **Degraded when slower than** turns a slow response Degraded. Set in the **Checks** side tab of the monitor form; the **Test** button lists every check. The API and configuration files gain `assertions` and `degradedAboveMs` in an HTTPS monitor's `config`. A JSON body over 1 MB is not parsed. See [Response checks](monitors.md#response-checks).
- **Actions**: an action sends an HTTP request when a monitor stays down or comes back up, for example to start a failover job in Jenkins. **Alerts → Actions** (administrators) creates actions with a URL, method, headers and a JSON body that accept the same `{{variables}}` as a webhook channel; the **Actions** side tab of a monitor links them to a status with a delay in minutes (a `down` action is dropped if the monitor recovers first) and a cooldown. Runs are retried up to 3 times, survive a restart, and are listed in the run history in **Delivery history → Actions**, where a failed run can be retried by hand. **Run now** shows the HTTP status and the start of the answer. Tokens and passwords are kept in **vault secrets**, any number of them, each under a name and used as `{{secret_<name>}}` (or `{{secret_<name>_basic}}` for a user and password) in the URL, headers or body, so they are never stored with the action or shown in the history; the **Secrets** and **Notify when a run fails** tabs sit at the right edge of the form. Redirects are not followed. The channels chosen under **Notify when a run fails** are told once a run has failed after its last attempt (a new **Action failed** event). Actions are exported and imported as `Action` documents, and a monitor lists them in `actions`. The API gains `/actions` and a new `actions` token permission, and `GET /config/export` leaves actions out for a caller who may not read them. See [Actions](actions.md).

## [0.3.0] - 2026-10-11

### Added

- **Longer chart ranges and uptime % in the chart block**: the status page chart block can show the last 30 or 90 days, and **Show uptime %** adds the monitor's uptime over the same range to its header. `GET /api/v1/public/monitor/:id/history` accepts `hours` up to 2160 (was 168). See [Customizing the status page](customizing-the-status-page.md).

- **Prometheus metrics**: `GET /api/v1/admin/metrics` exposes monitor status, latest response time, last check time, TLS certificate expiry and the number of open incidents in the Prometheus text format. It is protected by an API token with the new read-only `metrics` permission. See [Prometheus metrics](api.md#prometheus-metrics).

- **Automatic incidents**: a monitor can open an incident by itself when it stays down for a set number of minutes (set in the **Incident** side tab of the monitor's form) and resolve it after recovery. The incident is created as a **draft**, visible only in the admin console until you press **Publish**, or published right away. **Incidents → New Incident** can also save a draft. Incidents are written from **incident templates** with `{{monitor}}`, `{{duration}}`, `{{error}}` and `{{status}}` placeholders: a built-in default one, which can be edited, and custom ones (**Incidents → Templates**), chosen per monitor. The API gains `autoIncidentMinutes`, `autoIncidentMode` and `autoIncidentTemplateId` on monitors, `draft` on incidents and `/incident-templates`. Templates can carry wording for each language of the status page, so a visitor who switches language sees the automatic incident in it. Configuration files can switch them on with an `autoIncident` block (see [Configuration as code](configuration-as-code.md#automatic-incidents)). See [Automatic incidents](incidents-and-maintenance.md#automatic-incidents). Downgrading to a build without drafts would show draft incidents publicly.

- **New-version notice**: the **Application** card on **System Health** links to the release when GitHub has a newer one. The server checks in the background every 6 hours and shows the result on the Dashboard to administrators too; `UPDATE_CHECK=false` turns the check off. See [System Health](users-and-roles.md#system-health).

- **What's new and documentation link**: after an update each user sees **What's new** with the entries of the changelog they have not seen, and the sidebar has a **Documentation** link. See [Documentation link and What's new](users-and-roles.md#documentation-link-and-whats-new). The Dashboard of an instance without monitors has an **Add your first monitor** button.

- **Install script**: `curl -fsSL https://betterstatuspage.dev/install.sh | sh` downloads the Compose file and `.env` template, generates `JWT_SECRET` and `VAULT_ENCRYPTION_KEY`, and starts the container. It is safe to run again and never overwrites an existing `.env`; `BSP_DIR` and `BSP_REF` change the install directory and the downloaded branch or tag. See [Quick install](deployment.md#quick-install-script).
- **Telegram notification channel**: send monitor alerts, recoveries and TLS certificate warnings to a Telegram chat, group or channel through your own bot (bot token and chat ID), with the same severity emoji, optional templated line and alert hygiene as the other channels. A saved bot token is shown only by its last four characters, and it can be read from the vault instead of being stored in the channel. See [Telegram integration](telegram-integration.md).
- **HashiCorp Vault**: a vault can now read its secrets from a HashiCorp Vault KV v2 engine, using a token or AppRole, with an optional namespace and CA certificate. Secrets are references to a path (and key); values are read live on every use and never stored. Monitors and SMTP settings pick them from the same **From Vault** switch. **Test connection** checks the credentials, also before the vault is saved. The token, or the Role ID and Secret ID, can be read from a secret in a local vault instead of being typed (a Secure Value, User / Password or JSON secret). See [HashiCorp Vault](vault.md#hashicorp-vault). Downgrading to a version without this support leaves these vaults unusable until you upgrade again.

- **Monitor details page**: click a monitor's name in **Monitoring → Monitors**, or its tile on the **Dashboard**, to see its response time chart (average, p95 or maximum, in the style of the status page), uptime bars (hourly, 6-hourly or daily, depending on the range), response percentiles (p50, p95, p99), the 10 latest failed checks with their errors, incidents with their MTTR and the monitor's configuration, for the last 24 hours, 7, 30 or 90 days. See [Monitor details](monitors.md#monitor-details).

- **Keys for monitors and notification channels**: every monitor and notification channel now has a unique, technical **key** (lowercase letters, digits, `-` and `_`) next to its name. The admin panel does not show it in its forms. It is generated from the name, or given when the object is created through the API, and never changes afterwards, not even when the name does; it identifies the object in API clients and configuration files. Existing monitors and channels get a key from their name when the database is upgraded (`name`, then `name-2`, `name-3` for repeats); downgrading to a build without keys is not supported once the keys exist.

- **API tokens**: **Administration → API tokens** creates tokens for scripts and CI/CD. A token carries the permissions you tick, per part of the application, instead of a role: read or write for monitors, notification channels, incidents, maintenance windows, subscribers and the status page's appearance, read for reports, the audit log and system health, and a separate `vault:use` permission to use vault secrets in monitors, channels and the SMTP settings (write includes read). The presets **Report incidents**, **Deploy monitoring** and **Read only** fill in the usual sets. A token expires after 90 days unless **Never expires** is chosen, is sent as `Authorization: Bearer <token>` to the admin API, and is shown once; only its hash is stored. A request without the needed permission is refused with `403` naming it. A token cannot manage users, single sign-on, status page access, vaults, backups or other tokens, belongs to no user (it keeps working when the administrator who created it is demoted or deleted), is limited to 300 requests per minute, and is named in the audit log as `token: <name>`. See [API](api.md#permissions).

- **OpenAPI description of the admin API**: [`openapi.yaml`](https://docs.betterstatuspage.dev/openapi.yaml) documents the operations meant for scripts and CI/CD (monitors, incidents, maintenance windows, notification channels, layout, configuration export and import) with their bodies, limits and the permission each needs. See [API](api.md).

- **Configuration as code**: monitors and notification channels can be written as YAML documents with a `kind` (`Monitor`, `NotificationChannel`), identified by key instead of numeric id, with known secret fields masked as `••••••••` and vault secrets named by vault and secret. Several documents can share a file, separated by `---`. See [Configuration as code](configuration-as-code.md).
  - **YAML button**: a monitor (its page and its edit form), and a notification channel (its edit form) have a **YAML** button that shows the saved object as a document, with **Copy** and **Download**. It is read only.
  - **Import**: the **Import YAML** button on **Monitors** and **Notifications** takes pasted or uploaded documents (up to 2 MB), checks them as you type, lists what they would create and update (never the values of settings), or every problem with its place, and applies them completely or not at all. Importing needs the Operator role. An import never deletes anything, and a stored secret is kept when the document has `••••••••` in its place.
  - **API**: `GET /api/v1/admin/config/export` writes every document, or one with `?kind=&key=`; `POST /config/validate` and `/apply` read YAML only: one document or several separated by `---`. A token needs `monitors` and `channels` permission for the kinds involved, and `vault:use` to add a vault reference or change a monitor or channel that has one. Changing which channels a monitor alerts through also needs `channels:write`.

### Changed

- **Database credentials moved to a side tab**: for a Database monitor, the user and password (or the Vault secret holding the connection string) are now on a **Credentials** tab beside the form, like **Auth** for an HTTP(S) monitor. It opens by itself when you choose the Database type, shows ✓ when credentials are set and ! when they are missing, and a database monitor can no longer be saved without them. See [Database monitors](monitors.md).

- **Admin menu regrouped**: the sidebar now has **Monitoring**, **Alerts** (**Notifications** and **Delivery history**), **Status page** (**Page Builder**, **Branding**, **Localization**, **Subscribers**) and **Administration**. Import has no menu entry any more: **Monitors** and **Notifications** have an **Import YAML** button instead.

- **Saved secrets are masked everywhere**: a monitor's password, OAuth2 client secret, database password and credential headers, and a channel's Slack, Discord or Teams webhook URL, webhook credential headers and Telegram bot token now read back as `••••••••` in the form and in the API. Leave a field untouched to keep the stored value, or enter a new one. The **Test** button of a saved monitor uses the stored secrets. A stored secret is only kept while it is sent to the same place: changing a monitor's URL, token URL, CAS server, database host or port, or a webhook channel's URL asks you to enter the secrets again. See [Saved secrets](monitors.md#saved-secrets).
- **Stricter input checks in the API**: a monitor's `intervalSecs` (10 to 86400), `timeoutMs` (1000 to 300000), `retries` (1 to 10), `config` (an object) and `tags` are validated, a maintenance window needs a name and a start before its end, with existing monitors, a channel's `config` must be an object, `PUT /layout` needs a `tree`, and changing the type of a monitor or channel needs a new `config` in the same request. The admin panel already stayed within these limits.
- **Notification channel type picker**: the type in **New Notification Channel** is now a searchable dropdown, like the monitor type, instead of a row of buttons, so it stays one control tall as more channel types are added.

### Fixed

- **Switching a monitor to credentials from a vault**: choosing **From Vault** for a monitor's basic, OAuth2, CAS or database credentials now removes the username, password or client secret that were entered directly, so a monitor no longer keeps both (and shows both in its YAML).
- **Development restart after a killed process**: starting the API no longer fails with "BetterStatusPage is still running" when the previous process was killed (Ctrl+C or a hot reload on Windows) less than 30 seconds earlier.
- **Date and time format**: the admin panel shows dates as `dd.mm.yyyy` and 24-hour time by default, regardless of the browser language. **Settings → Date and time format** lets you pick `dd-mm-yyyy`, `mm/dd/yyyy`, `yyyy-mm-dd`, `yyyy.mm.dd` or 12-hour time; the choice is stored per browser. See [Date and time format](users-and-roles.md#date-and-time-format).

## [0.2.1] - 2026-10-08

### Added

- **PostgreSQL, MySQL / MariaDB and MongoDB monitors**: run a test query (for MongoDB, a JSON command), like the SQL Server monitor. They appear in the form as one **Database** type with an **Engine** selector, together with SQL Server. Connect with individual fields or a connection string from the vault; an optional **Expected Result** (first column of the first row) makes a mismatch Degraded; includes the **Test** button. MySQL and MariaDB share one type. See the [monitors guide](monitors.md#sql-server-postgresql-mysql--mariadb-and-mongodb).
- **Docker monitor**: checks the state and healthcheck of a container through the Docker Engine API, over a local socket, a Windows named pipe or HTTP(S). Running and healthy is operational; restarting, unhealthy or starting is degraded; stopped, paused or missing is down. Includes the **Test** button. See the [monitors guide](monitors.md#docker).
- **Subscriber delivery history**: the **Subscribers** tab of **Monitoring → Delivery history** lists every notification sent to subscribers with its status, attempts and last error, filters by status, event and subscriber (the history icon on a subscriber's row), and has **Retry now** for failed deliveries. See [Delivery history](subscriptions.md#delivery-history).

- **Uptime reports**: **Monitoring → Reports** shows the uptime, checks, average response time and incident count of every monitor for any date range (up to 366 days, within the result retention), and exports it as a summary or daily CSV. See [Uptime reports](reports.md).

- **Status page link in the admin sidebar**: **Status page**, above **Settings**, opens the public status page in a new tab.

### Changed

- **Delivery history moved to Monitoring**: the notification and subscriber delivery histories are now the two tabs of one **Monitoring → Delivery history** page, instead of separate pages under Notifications and Subscribers. The **Delivery history** buttons on those pages and the history icon on a subscriber's row open the right tab, and the old addresses redirect. See [notification delivery history](notification-channels.md#delivery-history) and [subscriber delivery history](subscriptions.md#delivery-history).
- **Faster loading**: the admin panel loads each page on demand, and the public status page loads its charts only when the page has one, so the first load transfers noticeably less JavaScript.
- **Subscribers page**: now two tabs, **Subscribers** and **Settings**. Methods are listed as rows with **Copy** buttons for their addresses, and a bar at the bottom offers **Save settings** and **Discard** while there are unsaved changes. In the list, tick subscribers to **Export** them as CSV or **Delete** several at once; **Export CSV** exports the current filter. See [Managing subscribers](subscriptions.md#managing-subscribers).
- **Monitor form**: the type is picked from a searchable list grouped by area instead of a row of buttons, so the form no longer grows with every new monitor type. The type-specific fields now come right after the type, and **Interval**, **Timeout**, **Attempts**, **Alert after** and **Recover after** sit in a collapsed **Schedule & alerting** row that shows their current values.

### Fixed

- **Incidents block**: an **Incident limit** above 10 now works on the public status page. It fetched at most 10 resolved incidents, whatever the limit was.
- **Discord notifications**: the channel form now has an **Avatar URL** field, so saving a channel no longer drops an avatar set through the API. Without an avatar, messages use the BetterStatusPage logo.
- **Audit log**: the **Entity** filter now lists every recorded type: user security, branding, page layout, languages, backups, backup schedule and notification deliveries.
- **Delivery history**: the **Event** filter now includes **Certificate**.
- **HTTP(S) monitor**: a GET or HEAD monitor with an empty request body now passes scheduled checks, not only the **Test** button. The body is ignored for these methods.
- **Ping monitor**: the **Test** button now sends an ICMP ping in ICMP mode, instead of always opening a TCP connection.
- **Webhook notifications**: variables such as `{{error_message}}` are now escaped inside the JSON body, so quotes and new lines no longer produce invalid JSON.
- **SMTP with a Vault secret**: a **Secure Value** secret (no username) now makes sending fail with a clear error instead of silently sending without signing in. The SMTP form warns about it.
- **Maintenance windows**: saving a window with no monitors selected and "all monitors" unchecked is now rejected with a message, instead of being saved as a window that suppresses nothing.
- **Status page translations**: English text overrides set in **Settings → Translations** now apply on the public status page.

### Removed

- **"None" incident impact**: the option is gone from the incident form, along with its translation key `incident.impact.none`. Incidents now have `minor`, `major` or `critical` impact.

## [0.2.0] - 2026-10-02

BetterStatusPage now has a home of its own: the project website at [betterstatuspage.dev](https://betterstatuspage.dev) and full documentation at [docs.betterstatuspage.dev](https://docs.betterstatuspage.dev).

### Added

- **Single sign-on with OpenID Connect**: Microsoft Entra ID, Keycloak, Okta, Google Workspace, Authentik, Auth0 and other providers, configured in **Users → Single sign-on** without a restart. Authorization Code flow with PKCE, `state` and `nonce`. See the [single sign-on guide](single-sign-on.md).
  - The first sign-in matches the account by verified email, then links it to the provider's issuer and `sub`, so later sign-ins keep working when the email changes.
  - Microsoft Entra ID verified-email claim (`xms_edov`) is supported.
  - Password sign-in can be disabled while SSO is active, with safeguards against locking everyone out.
  - Two-factor authentication still applies after an SSO sign-in for users who turned it on.
  - Every sign-in, allowed or denied, is written to the audit log with the reason.
- **Private status pages**: the page shows its content only to signed-in users; everyone else gets a sign-in screen in the page's own branding. See the [private status page guide](private-status-page.md).
- **Viewer role**: can view a private status page but not the admin console. SSO can create viewer accounts automatically for the email domains you list.
- **Documentation site** at [docs.betterstatuspage.dev](https://docs.betterstatuspage.dev).

### Changed

- Users are no longer asked to change their password when password sign-in is disabled.

### Fixed

- Page builder: dragging blocks into groups.

### Upgrading from 0.1.x

Point `BSP_IMAGE` in `.env` at the `0.2.0` image tag, then `docker compose pull && docker compose up -d`. Database migrations run automatically on startup and no new `.env` variables are required. SSO uses `PUBLIC_URL` to build its callback URL, so set it before turning SSO on.

## Earlier releases

Versions 0.1.0 – 0.1.6 were released before this changelog was started; see the [Git tags](https://github.com/BElluu/BetterStatusPage/tags).
