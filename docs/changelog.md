# Changelog

All notable changes to BetterStatusPage are documented in this file.
The project follows [Semantic Versioning](https://semver.org/); while it is below 1.0, a new minor version marks new features.

## [Unreleased]

### Added

- **Telegram notification channel**: send monitor alerts, recoveries and TLS certificate warnings to a Telegram chat, group or channel through your own bot (bot token and chat ID), with the same severity emoji, optional templated line and alert hygiene as the other channels. See [Telegram integration](telegram-integration.md).
- **Monitor details page**: click a monitor's name in **Monitoring → Monitors**, or its tile on the **Dashboard**, to see its response time chart (average, p95 or maximum, in the style of the status page), uptime bars (hourly, 6-hourly or daily, depending on the range), response percentiles (p50, p95, p99), the 10 latest failed checks with their errors, incidents with their MTTR and the monitor's configuration, for the last 24 hours, 7, 30 or 90 days. See [Monitor details](monitors.md#monitor-details).

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
