<div align="center">

**English** · [Polski](README.pl.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/status/public/logo_dark.png">
  <source media="(prefers-color-scheme: light)" srcset="apps/status/public/logo_light.png">
  <img alt="Better Status Page" src="apps/status/public/logo_light.png" width="320">
</picture>

<br />

**A self-hosted status page that doesn't make you cry. 🟢**

*Monitor your services. Alert your team. Keep your users in the loop.*
*No cloud. No subscription. No drama.*

**[🌐 Website](https://betterstatuspage.dev)** · **[🚀 Live demo](https://demo.betterstatuspage.dev/)** · **[📖 Documentation](https://docs.betterstatuspage.dev)**

[![Node.js](https://img.shields.io/badge/Node.js-26+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://typescriptlang.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)](https://fastify.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## The pitch 🎤

You know the drill. Your API goes down at 3 AM, users start tweeting, your boss is calling, and your status page is... a static HTML file someone last updated in 2019 that says "All systems operational" in Comic Sans.

**BetterStatusPage** fixes that. It's a fully self-hosted monitoring and status page platform that runs as a **single Node.js process with zero external dependencies** — no Postgres, no Redis, no Kubernetes, no $200/month SaaS bill. Just clone, configure, deploy. Done.

---

## Release status

BetterStatusPage is currently in beta. The current target is a practical self-hosted deployment for small teams and personal infrastructure:

- one Node.js 26 process,
- SQLite persistence,
- Docker Compose deployment,
- Nginx reverse proxy,
- built-in backups and offline restore,
- no external database, queue, or cache required.

Thank you in advance for your interest in the project and for every installation, test, bug report, and piece of feedback. Early real-world testing is especially valuable and will directly help shape BetterStatusPage on the way to a stable release.

Full documentation: **https://docs.betterstatuspage.dev**. Before exposing a production instance, read:

- [Deployment guide](https://docs.betterstatuspage.dev/deployment/)
- [Backup and restore guide](https://docs.betterstatuspage.dev/backup-restore/)
- [Alert hygiene guide](https://docs.betterstatuspage.dev/alert-hygiene/)
- [Status page subscriptions guide](https://docs.betterstatuspage.dev/subscriptions/)
- [Private status page guide](https://docs.betterstatuspage.dev/private-status-page/)
- [Static fallback guide](https://docs.betterstatuspage.dev/static-fallback/)
- [Users and roles guide](https://docs.betterstatuspage.dev/users-and-roles/)
- [Security policy](https://github.com/BElluu/BetterStatusPage/security/policy)

---

## What it does 🚀

### 🔍 Nine ways to monitor things

| Type | What it checks |
|------|---------------|
| **HTTPS** | URLs, status codes, response times, keywords in the body, header and JSON field checks, a slow-response limit, full auth flows (Basic, OAuth2, CAS), and optional TLS certificate expiry warnings |
| **Ping / TCP** | Whether a host is alive — via ICMP or TCP port check |
| **DNS** | Whether your records resolve correctly — A, AAAA, MX, CNAME, TXT, with custom resolver support |
| **SQL Server** | Runs a test query against MSSQL and validates the result |
| **PostgreSQL** | Runs a test query against PostgreSQL and validates the result |
| **MySQL / MariaDB** | Runs a test query against MySQL or MariaDB and validates the result |
| **MongoDB** | Runs a test command against MongoDB and validates the result |
| **Docker** | State and healthcheck of a container, through the Docker Engine API |
| **Webhook** *(passive)* | Lets external services ping *you* to signal they're alive — silence means trouble |

Every monitor gets: configurable intervals, timeouts, retries, **color-coded tags** for grouping, a **30-day uptime bar** on the status page, and 90 days of check results kept by default, with a per-monitor admin page for uptime, response-time percentiles, incidents and recent failures. Oh, and there's a built-in test runner so you can validate your config before hitting Save and immediately regretting it.

> See **[docs.betterstatuspage.dev/monitors](https://docs.betterstatuspage.dev/monitors/)** for every monitor type, auth flows, heartbeat URLs, certificate warnings and dependencies.

### 🔔 Notifications that actually reach people

When something breaks (or recovers), BetterStatusPage can shout at you via:

- **Email** — SMTP with TLS, custom sender, and template variables
- **Webhook** — fire at Slack, PagerDuty, or literally anything with an HTTP endpoint
- **Discord** — native integration with rich embeds; color-coded by severity (red = down, orange = degraded, green = recovery), no bot token required — just a webhook URL
- **Microsoft Teams** — native MessageCard integration; color-coded cards, no app installation required — just an incoming webhook URL
- **Slack** — native Block Kit integration; color-coded attachments, optional `<!here>` / `<!channel>` mentions — just an incoming webhook URL
- **Telegram** — messages through your own bot with a severity emoji (🔴 / 🟡 / 🟢) — just a bot token and a chat ID
- **ntfy** — push notifications to a topic on ntfy.sh or your own server, high priority when a monitor is down — just a topic
- **Pushover** — push notifications to your phone, high priority when a monitor is down — just an application token and a user key

All channels support template variables like `{{monitor_name}}`, `{{status}}`, `{{error_message}}` etc., so your alerts can say *"API Gateway is down: connection timeout"* instead of *"status changed"*.

Recovery notifications are optional per channel — because sometimes you want to know when things come back up, and sometimes you just want to sleep.

**TLS certificate expiry warnings** — switch them on per HTTPS monitor and pick the lead time (14 days by default). The monitor's channels get one warning when the certificate enters that window, then reminders 7, 3 and 1 days before it expires, and an all-clear once it has been renewed (if the channel sends recoveries). The certificate is read every 6 hours; the public status page is not affected, and a certificate that has already expired fails the check and alerts as down. The admin monitor list shows how many days each certificate has left, and the test runner shows the expiry date. Certificate notifications add the template variables `{{event_type}}` (`certificate`), `{{cert_expires_in}}`, `{{cert_expires_at}}`, `{{cert_days_left}}` and `{{cert_host}}`; `{{status}}` is `cert-expiring` or `cert-renewed`.

Every delivery is persisted with its individual attempts. Failed sends retry automatically after 1 and 5 minutes, then remain visible in the admin delivery history for manual retry. Delivery history is retained for 180 days.

> See **[docs.betterstatuspage.dev/notification-channels](https://docs.betterstatuspage.dev/notification-channels/)** for email, webhook, template variables and delivery retries.
> See **[docs.betterstatuspage.dev/discord-integration](https://docs.betterstatuspage.dev/discord-integration/)** for a step-by-step Discord setup guide.
> See **[docs.betterstatuspage.dev/teams-integration](https://docs.betterstatuspage.dev/teams-integration/)** for a step-by-step Microsoft Teams setup guide.
> See **[docs.betterstatuspage.dev/slack-integration](https://docs.betterstatuspage.dev/slack-integration/)** for a step-by-step Slack setup guide.
> See **[docs.betterstatuspage.dev/telegram-integration](https://docs.betterstatuspage.dev/telegram-integration/)** for a step-by-step Telegram setup guide.

### 🤫 Alert hygiene — the reason people keep alerts switched on

An alerting system you had to mute is worse than no alerting system. Four controls, all **off by default**, so nothing changes until you ask for it:

- **Failure / recovery thresholds** — per monitor. Alert only after N consecutive failed checks. One flapping endpoint stops paging you every minute, while the public status page still updates instantly.
- **Quiet hours** — per channel, with a real IANA timezone. Notifications are either held until the window ends or dropped. "Hold" is the sane default: you sleep, nothing is lost.
- **Rate cap** — per channel: *no more than X alerts from this monitor per hour*. Recoveries are never capped, so the all-clear always gets through.
- **Grouping** — per channel: if enough distinct monitors fall inside the same window, you get **one** digest instead of twenty messages. Windows that never became a burst are sent individually, so a lone alert is never swallowed.

Everything the rules stop is still recorded in the delivery history with the reason — so you can check what was *not* sent and loosen the rule if it was too strict.

> See **[docs.betterstatuspage.dev/alert-hygiene](https://docs.betterstatuspage.dev/alert-hygiene/)** for how the rules combine, how to pick values, and the API shape.

### 🎬 Actions — do something when a monitor changes

A notification tells people. An **action** changes something: it sends an HTTP request when a monitor stays down for a set time, or comes back up. Start a standby server through a Jenkins job when your primary is down for five minutes, stop it again when the primary is back.

- **Per monitor, per status** — link an action to a monitor for `down` or back `up`, with a **delay** (a `down` action is dropped if the monitor recovers first) and a **cooldown** so a flapping check cannot run it again and again.
- **Secrets stay in the vault** — a token or a password is read from a [vault](#-a-vault-for-your-secrets) secret when the request is sent (`Authorization: Basic {{secret_jenkins_basic}}`), as many as you need, and is never stored with the action or shown in the run history.
- **Retries and history** — a failed request is tried up to 3 times, runs survive a restart, and every run is listed in **Delivery history → Actions**, where a failed one can be retried by hand.
- **Told when it fails** — choose which notification channels hear about a run that failed after its last attempt.
- **Test it for real** — **Run now** sends the request and shows the HTTP status and the start of the answer.
- **As code** — actions are exported and imported as YAML, next to your monitors and channels.

Only administrators manage actions. See **[docs.betterstatuspage.dev/actions](https://docs.betterstatuspage.dev/actions/)**.

### 🔐 A vault for your secrets

Storing passwords in environment variables is fine until it isn't. BetterStatusPage has a built-in **AES-256-GCM encrypted vault** where you can stash credentials and reference them from monitors and SMTP settings. Supports:

- **userpass** — classic username + password
- **value** — a single secret string (API token, connection string)
- **json** — a full JSON object, with **field mapping** to pick out exactly the keys you need

Prefer to keep secrets elsewhere? A vault can also read them live from **HashiCorp Vault** (KV v2, token or AppRole) instead of storing them.

Your secrets never appear in logs, list responses, the audit log, or your `git diff` — only an administrator who clicks **Reveal** sees a value.

> See **[docs.betterstatuspage.dev/vault](https://docs.betterstatuspage.dev/vault/)** for secret types, field mapping and where secrets can be used.

### 🔑 Single sign-on with OpenID Connect

Let your team sign in with the identity provider they already use — **Microsoft Entra ID, Keycloak, Okta, Google Workspace, Authentik, Auth0** or any other OIDC provider. Authorization Code flow with PKCE, `state` and `nonce`, ending in the same hardened server-side session as a password login.

- **Configured in the UI, live immediately** — open **Users → Single sign-on**, paste issuer, client ID and secret, hit **Test connection**, save. No `.env` edit, no restart. The secret is stored encrypted and never shown again.
- **Existing users only** — users are matched by verified email and keep their BetterStatusPage role, so nobody gets in by accident. The only accounts SSO can create are Viewer accounts for a private status page, and only for email domains you list.
- **Password login stays as a safety net** — or switch it off once SSO works. It can only be switched off after a successful discovery check, and `OIDC_FORCE_PASSWORD_LOGIN=true` is the break-glass switch if your IdP goes down.
- **Infrastructure-as-code friendly** — the same settings can come from `OIDC_*` environment variables, which then override and lock the UI form.
- **Audited** — every sign-in, allowed or denied, and every settings change lands in the audit log (the secret never does).

> See **[docs.betterstatuspage.dev/single-sign-on](https://docs.betterstatuspage.dev/single-sign-on/)** for setup, provider notes and troubleshooting.

### 🎨 A drag-and-drop page builder

The public status page isn't just a list of green dots. It's a fully customizable grid layout you design yourself — drag in monitor cards, group them by service (and drag them into or out of groups), add markdown text blocks, drop in an incident feed, resize everything, done. No CSS required.

> See **[docs.betterstatuspage.dev/customizing-the-status-page](https://docs.betterstatuspage.dev/customizing-the-status-page/)** for the builder blocks, branding, dark mode and translations.

### 📢 Incident management

Create incidents, set severity (minor → major → critical), link affected monitors, post real-time updates as the situation unfolds, and mark resolved when the dust settles. On the public page, an active minor incident marks its linked monitors as degraded, while major and critical incidents mark them as down. Resolving the incident restores the status reported by monitoring checks. A monitor can also open an incident by itself when it stays down for a set time, as a draft you publish or published at once, written from a default or custom template, and close it after recovery.

### 📬 Subscriptions for your audience

Notification channels wake up your team; subscriptions keep **your users** in the loop. Visitors subscribe from the status page by email or webhook, add the feed to a Slack channel with `/feed subscribe`, follow the RSS/Atom feed, or poll the JSON status API (`summary.json`, `components.json`).

- **You decide what can be sent** — pick the channels and event types on offer (new incidents, updates, resolutions, scheduled maintenance). Subscribers choose from those, and can narrow them to the components or tags they care about.
- **Double opt-in** by email, with a manage link and RFC 8058 one-click unsubscribe in every message
- **Only what you publish** — incidents and maintenance, never monitor flaps. A *Notify subscribers* checkbox lets you post quietly.
- **Configurable webhooks** — subscribers pick the HTTP method and custom headers, can be emailed when their endpoint stops responding, and failing endpoints are paused automatically
- **Delivery history** — see every notification sent to subscribers with its status and last error, retry failed ones, and export the subscriber list as CSV
- **A safe public form** — rate limit, honeypot, no way to discover who is subscribed, and webhook URLs that can never point into your own network

> See **[docs.betterstatuspage.dev/subscriptions](https://docs.betterstatuspage.dev/subscriptions/)** for setup, delivery rules and the webhook payload.

### 🔒 Private status pages

Not every status page is for the whole internet. Switch on **Users → Status page access → Private status page** and only signed-in users see it. Everyone else gets a sign-in screen in your page's branding, with password and SSO sign-in.

- **A Viewer role** — for people who should only see the page; the admin console stays closed to them
- **Viewer accounts from SSO** — optionally, anyone who signs in through your identity provider with a verified email from a domain you list gets a Viewer account on their first visit
- **Nothing leaks** — status data, history and the live stream need a session; feeds and the JSON status API switch off; responses are marked `private` and `noindex`

> See **[docs.betterstatuspage.dev/private-status-page](https://docs.betterstatuspage.dev/private-status-page/)** for who can view a private page and what it switches off.

### 🛟 Static fallback

When the server that runs your status page is down, so is the page. Switch on **Static fallback** and the instance pushes a saved copy of the public page, with a `snapshot.json` of the latest statuses and incidents, to S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO) every minute. Visitors sent to the copy still see the last known state, with a banner saying when it was taken.

- **Same page, no server** — the copy is the status page itself, reading its data from the snapshot
- **Only what you publish** — the snapshot holds what the public page serves, nothing about internal monitors or drafts
- **Never a private page** — a private status page is not pushed
- **Health** — **System Health** shows whether the last push worked, and **Check access** tries a new target without pushing

> See **[docs.betterstatuspage.dev/static-fallback](https://docs.betterstatuspage.dev/static-fallback/)** for setup, what the copy cannot do and how to send visitors to it.

### 📊 Uptime reports

The status page shows 30 days; **Monitoring → Reports** in the admin console covers any date range you still have results for (90 days by default). See uptime, checks, average response time and incidents per monitor, and export a summary or a day-by-day CSV for SLA reviews.

> See **[docs.betterstatuspage.dev/reports](https://docs.betterstatuspage.dev/reports/)** for how uptime is counted and the CSV columns.

### 🔧 Maintenance windows

Scheduled that 3 AM database migration? Let people know in advance instead of letting them think you're on fire.

Maintenance windows suppress alert noise for the duration of planned downtime — no more on-call pages for work you're doing on purpose. Create a window with a name, description, start/end time (optionally repeating every day or on chosen weekdays), and optionally scope it to specific monitors (or flip the switch for "all monitors"). While a window is active:

- Notification channels stay quiet for affected monitors — status changes are still tracked, just not shouted
- The public status page shows a maintenance banner with the window name and end time
- Individual monitor cards display a **MAINTENANCE** chip so visitors know what's happening
- The admin dashboard sorts windows into **Active / Upcoming / Past** so you always know what's scheduled

> See **[docs.betterstatuspage.dev/incidents-and-maintenance](https://docs.betterstatuspage.dev/incidents-and-maintenance/)** for incident statuses, impact and exactly what a maintenance window silences.

### 🕵️ Audit log

Six months from now, someone will ask *"who changed the check interval on the payments monitor from 30 seconds to 5 minutes last Thursday?"* The answer is in the audit log.

Every mutation in the admin panel is recorded — who did it, when, and exactly what changed. For updates, you get a field-level diff with before and after values (sensitive fields like passwords are always redacted). Covered entities:

| What | Tracked operations |
|------|--------------------|
| Monitors | Create, update (name, type, interval, timeout, retries, tags, config), delete |
| Incidents | Create, update (title, status, impact), delete |
| Maintenance windows | Create, update, delete |
| Notification channels | Create, update (name, type, enabled, config), delete |
| SMTP settings | Configure / update |
| Subscription settings | Configure or change methods, notification types and component scope |
| Subscribers | Delete (single or several at once) |
| Subscriber deliveries | Manual retry of a failed delivery |
| Vaults & secrets | Create, update (name, value change flagged as `[redacted]`), delete |
| Users | Create, role change, password reset, delete |
| API tokens | Created or revoked (never the token), and every change made with one, under the creator's email and the token's name |
| Import | Each import with its counts, and every monitor and channel it changed |
| User security | Enable or disable TOTP two-factor authentication, password changes, SSO account linking, revoked temporary passwords |
| SSO settings | Configure or change OpenID Connect settings |
| Branding, page builder, translations | Branding saves, layout saves, locale and translation changes |
| Backups | Backup created or deleted, automatic backup schedule changes |
| Notification deliveries | Manual retry of a failed delivery |
| Status page access | Make the status page private or public, viewer accounts from SSO and their email domains |
| Sign-ins | Every sign-in with a password or SSO: allowed, or denied with the reason (unknown email, wrong password, wrong 2FA code, refused by SSO…) |

The audit log page (admin-only) lets you filter by **user**, **entity type**, **action** (create / update / delete / allowed / denied), and **date range**. Click any row to expand the diff inline.

### 🌍 i18n, branding, the works

- **Multi-language support** — add your own locale, translate every string, set a default; English and Polish (`pl`) ship with complete built-in copy
- **Full branding** — site name, logo (light/dark variants or text), 14 theme colors, and a custom CSS field for when you really want to go wild
- **Uptime bar thresholds** — choose the daily uptime percentages (defaults 99.9 / 99 / 95) at which the 30-day bar turns green, yellow, orange or red
- **Layout toggles** — hide the status headline, the footer, or the small BetterStatusPage link in the bottom-right corner
- **Dark mode** — because it's not optional anymore. Visitors switch between light and dark; with custom branding on, the page gets one universal theme in your own colours instead

### 🔗 Monitor dependencies

Not every outage is what it looks like. When your API goes down because the database went down, you don't want three alerts — you want one, for the actual root cause.

BetterStatusPage lets you declare that **monitor A depends on monitor B**. When B goes down, A automatically shows **Dependency Issue** instead of Down — and its alert is suppressed, because B already fired it. Once B recovers, A returns to its normal status on the next check.

On the public status page, affected monitors display a **"Caused by: Database"** chip so visitors understand the hierarchy at a glance, not just a wall of red dots.

Configure it per monitor in the admin panel → monitor edit → **Depends on** tab.

### ⚡ Real-time, no refresh needed

Status changes propagate to both the admin dashboard and the public page instantly via **Server-Sent Events**. The moment a monitor flips from 🟢 to 🔴, everyone sees it. No polling, no page refresh, no "wait, is this stale?"

---

## Architecture 🏗️

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                              │
│                                                             │
│   ┌──────────────────┐        ┌──────────────────────────┐  │
│   │   Admin UI       │        │   Public Status Page     │  │
│   │   React 19       │        │   React 19               │  │
│   │   Vite · RQ · DnD│        │   SSE · i18n · dark mode │  │
│   └────────┬─────────┘        └────────────┬─────────────┘  │
└────────────┼───────────────────────────────┼────────────────┘
             │  REST + SSE                   │  REST + SSE
┌────────────▼───────────────────────────────▼────────────────┐
│                    Fastify 5  (Node.js 26+)                 │
│                                                             │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│   │  Admin API   │  │  Public API  │  │  Webhook API     │  │
│   │ Auth + RBAC  │  │ open/session │  │  token auth      │  │
│   └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                             │
│   ┌──────────────────────────────────────────────────────┐  │
│   │               Background Workers                     │  │
│   │                                                      │  │
│   │  Scheduler                  Notifier                 │  │
│   │  ├── HTTPS checker          Vault resolver           │  │
│   │  ├── Ping / TCP             Result purger (daily)    │  │
│   │  ├── DNS resolver                                    │  │
│   │  └── DB checkers (SQL, PostgreSQL, MySQL, Mongo)     │  │
│   └──────────────────────────────────────────────────────┘  │
│                                                             │
│   ┌──────────────────────────────────────────────────────┐  │
│   │           Drizzle ORM  ·  SQLite (WAL mode)          │  │
│   └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Why these choices?

**SQLite instead of Postgres** — A status page for most teams doesn't need a database server. SQLite in WAL mode handles concurrent reads and writes without breaking a sweat, has zero ops overhead, and your entire database is a single file you can back up with `cp`. If your status page grows to the point where SQLite is a bottleneck, you have much bigger problems (and probably a dedicated ops team).

**SSE instead of WebSockets** — Status updates only ever flow server → client. SSE handles that perfectly, uses plain HTTP, needs nothing from a reverse proxy beyond turning buffering off, and auto-reconnects. Why bring a bazooka to a knife fight?

**Monorepo with `@bsp/shared`** — The API and both frontends share one TypeScript package for all domain types. Change a type in one place, the compiler yells at you everywhere it matters. No "oh we forgot to update the frontend types" post-mortems.

**AES-256-GCM vault in-process** — A random 12-byte IV per secret, authentication tag verification on decrypt, secrets never logged. Everything a small team needs for encrypted secrets without standing up another service.

---

## Tech stack 🛠️

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js | 26+ |
| Language | TypeScript | 5.7 |
| Backend | Fastify | 5.x |
| Database | SQLite (`node:sqlite`) | built-in |
| ORM | Drizzle | 0.45 |
| Frontend | React | 19 |
| Build | Vite | 6.x |
| Styling | Tailwind CSS | 3.x |
| Data fetching | TanStack Query | 5.x |
| State | Zustand | 5.x |
| Drag & drop | dnd-kit | 6.x |
| Auth | Server-side sessions, HttpOnly JWT cookies, CSRF, TOTP, bcrypt, OpenID Connect (PKCE) | — |
| Email | Nodemailer | 9.x |
| SQL Server | mssql | 11.x |
| PostgreSQL | pg | 8.x |
| MySQL / MariaDB | mysql2 | 3.x |
| MongoDB | mongodb | 7.x |
| Scheduler | node-cron | 3.x |

---

## Quick production start

Docker Compose with the published GHCR image is the recommended deployment path. No clone is needed — the server only needs `docker-compose.yml` and `.env`.

### One-line install

On a Linux server with Docker and Docker Compose v2:

```bash
curl -fsSL https://betterstatuspage.dev/install.sh | sh
```

The script downloads `docker-compose.yml` and `.env.example`, generates `JWT_SECRET` and `VAULT_ENCRYPTION_KEY`, pulls the image and starts the container on `127.0.0.1:3000`. It installs into `/opt/bsp` as root and `~/bsp` otherwise (override with `BSP_DIR`), and is safe to run again: an existing `.env` is never overwritten. Keep a copy of `VAULT_ENCRYPTION_KEY` — backups do not include it. Prefer to see every step? Do it manually:

```bash
mkdir -p /opt/bsp && cd /opt/bsp
curl -fsSLO https://raw.githubusercontent.com/BElluu/BetterStatusPage/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/BElluu/BetterStatusPage/main/.env.example -o .env
chmod 600 .env
```

Edit `.env` and set at least:

```env
BSP_IMAGE=ghcr.io/belluu/better-status-page:0.6.0
JWT_SECRET=<random 32+ char secret>
VAULT_ENCRYPTION_KEY=<64-char hex key>
```

Generate safe values (run twice, one per secret):

```bash
openssl rand -hex 32
```

Start the application:

```bash
docker compose pull
docker compose up -d
```

Open `http://your-server:3000/admin` for first-run setup. For internet-facing deployments, put Nginx/SSL in front and keep the application port private. See [docs.betterstatuspage.dev/deployment](https://docs.betterstatuspage.dev/deployment/).

---

## Getting started for development ⚡

### You'll need

- **Node.js 26.10+** — we use the built-in `node:sqlite` module, so no ancient runtimes
- **npm 11+**

### Installation

```bash
git clone https://github.com/BElluu/BetterStatusPage.git
cd BetterStatusPage
npm install
```

### Development

```bash
npm run dev
```

Three things start:

| App | URL |
|-----|-----|
| API | `http://localhost:3000` |
| Admin | `http://localhost:5173` |
| Status page | `http://localhost:5174` |

Open the admin URL and you'll be greeted by a setup wizard. Create your admin account, and you're in.

The shared packages in `packages/*` are used from their built `dist`. `npm run dev` builds only the packages that changed since the last build (`npm run build:kit -- --force` builds all of them). To see an edit in a package while the apps run, watch it with `npm run dev -w @better-kit/<name>`.

### Quality checks

```bash
npm run lint            # ESLint for API, shared types, and both React apps
npm test                # API integration tests + frontend component tests
npm run test:api:coverage  # API tests with enforced coverage thresholds
npm run test:coverage   # frontend coverage report with enforced thresholds
npm run build           # strict TypeScript and production builds for all workspaces
npm run backup          # create a consistent database + uploads backup (after build)
```

Browser smoke tests use Playwright. Install Chromium once, then run the suite:

```bash
npx playwright install chromium
npm run test:e2e
```

The E2E suite starts from an empty instance every run (runtime data lives under `.e2e/` and is wiped first), walks through the setup wizard, and then covers monitors, incidents, maintenance, email subscriptions, the page builder's drag and drop, role-based access and a private status page with a viewer account. GitHub Actions runs lint, tests, coverage, builds, Playwright E2E, and a production Docker smoke test on pull requests and pushes to `main`.

### Production

```bash
npm run build   # builds the API and both frontends
npm start       # starts the API, which serves them as static files
```

One process. One port. That's it.

---

## Configuration ⚙️

Copy `.env.example` to `.env`:

```env
PORT=3000
NODE_ENV=production
BSP_IMAGE=ghcr.io/belluu/better-status-page:0.6.0
BSP_BIND_ADDRESS=127.0.0.1

JWT_SECRET=something-long-random-and-secret
VAULT_ENCRYPTION_KEY=64-char-hex-string   # see below

DATABASE_PATH=./data/db.sqlite
UPLOAD_DIR=./data/uploads

# Comma-separated list of allowed origins for CORS
ALLOWED_ORIGINS=https://status.example.com,https://admin.example.com

# Set only when port 3000 is reachable exclusively through one trusted reverse proxy
TRUST_PROXY=1

# Optional scheduler tuning
SCHEDULER_TICK_SECONDS=10
MONITOR_CHECK_CONCURRENCY=20
MONITOR_RESULT_RETENTION_DAYS=90
MONITOR_RESULT_PURGE_CRON=0 2 * * *

# Public URL of the status page — required for email and webhook subscriptions; all subscriber links use it,
# and SSO sign-ins started on a private page's sign-in screen return to it
PUBLIC_URL=https://status.example.com
# Optional: let subscriber webhooks reach internal addresses (intranet status pages only)
SUBSCRIBER_WEBHOOK_ALLOW_PRIVATE=false
# Optional: let monitors reach cloud metadata addresses (169.254.169.254 and the like)
MONITOR_ALLOW_METADATA=false
```

> 🔑 **Generate a vault encryption key:**
> ```bash
> openssl rand -hex 32
> ```
> Keep this somewhere safe. If it changes, all stored secrets become unreadable. Yes, all of them.

---

## User roles 👥

| Role | What they can do |
|------|-----------------|
| **admin** | Everything, including users, single sign-on, vaults, audit log, backups and API tokens |
| **operator** | Monitors, incidents, maintenance, notifications, import, page builder, branding, localization, and settings |
| **branding** | Page builder, branding, localization, and account settings |
| **viewer** | Views a [private status page](https://docs.betterstatuspage.dev/private-status-page/); no access to the admin console |

Administrator sessions are stored server-side and authenticated with an `HttpOnly`, `SameSite=Strict` cookie. State-changing browser requests require a matching CSRF token. Users of the admin console can enable TOTP two-factor authentication from **Settings** and receive eight single-use recovery codes; it applies to password and SSO sign-ins alike. Administrators can also enable [OpenID Connect single sign-on](https://docs.betterstatuspage.dev/single-sign-on/) from **Users → Single sign-on**. Sensitive actions (sign-in settings, 2FA, password changes) are confirmed the way the session signed in: with the current password, or by signing in again at the identity provider in a pop-up.

### API tokens

Scripts and CI/CD can call the admin API with a token from **Administration → API tokens**, for example to open an incident from a pipeline. A token carries only the permissions you tick (read or write for monitors, notification channels, incidents, maintenance, subscribers and the page's appearance, read for reports, the audit log and system health, and a separate one for using vault secrets) and expires after 90 days unless you choose otherwise. It is shown once, and cannot manage users, single sign-on, status page access, vaults, backups or other tokens.

> See **[docs.betterstatuspage.dev/api](https://docs.betterstatuspage.dev/api/)** for the token rules and `curl` examples.

### Configuration as code

Every monitor, notification channel and action can be written as a YAML document with a `kind`, identified by a key instead of a numeric id and with the known secret fields masked, for version control and review. A **YAML** button on a monitor, a channel and an action shows that object; **Export YAML** and **Import YAML** on the Monitors and Notifications pages (and the API) write out all of them and create or updates objects from pasted or uploaded documents, with a preview before anything is written. Documents are checked completely, applied in one transaction, and applying them twice changes nothing. An import deletes nothing unless you switch on **prune**, which removes what the file does not mention (listed in the preview first).

> See **[docs.betterstatuspage.dev/configuration-as-code](https://docs.betterstatuspage.dev/configuration-as-code/)** for the format and what is included.

---

## Deployment 📦

### Behind Nginx (recommended)

```nginx
server {
    listen 443 ssl;
    server_name status.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # SSE requires these — don't skip them
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

### With PM2

```bash
npm i -g pm2
pm2 start npm --name "bsp" -- start
pm2 save && pm2 startup
```

### With Docker Compose (recommended)

Download `docker-compose.yml` and `.env.example` (saved as `.env`) as shown in [Quick production start](#quick-production-start), set `BSP_IMAGE`, `JWT_SECRET` and `VAULT_ENCRYPTION_KEY` in `.env`, then:

```bash
docker compose pull
docker compose up -d
```

Data (SQLite database + uploads) is stored in a named Docker volume (`bsp_data`) and survives container rebuilds, restarts, and image upgrades. It is only deleted if you explicitly run `docker compose down -v`.

To build the image from source instead, clone the repository and use the local override so the production Compose file continues to use GHCR:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

See **[docs.betterstatuspage.dev/deployment](https://docs.betterstatuspage.dev/deployment/)** for the full deployment guide, including Nginx + SSL setup, bare-metal install, PM2, backups, and firewall configuration.

---

## Production checklist

Before making an instance public:

- Set `NODE_ENV=production`.
- Replace `JWT_SECRET` with a random non-default value.
- Set `VAULT_ENCRYPTION_KEY` to a random 64-character hex value and store it outside the app.
- Put the app behind Nginx/SSL and avoid exposing port 3000 directly.
- Set `TRUST_PROXY=1` only when the app is reachable exclusively through your reverse proxy.
- Create a backup and verify it.
- Perform a test restore on a non-production copy.
- Confirm release checks are green: lint, tests, build, Docker build, and E2E on Linux CI.
- Review the [security policy](https://github.com/BElluu/BetterStatusPage/security/policy) before opening public issue reporting.

---

## Project structure 📁

```
BetterStatusPage/
├── apps/
│   ├── api/           # Fastify backend: monitors, workers, incidents, public routes
│   │   └── src/
│   │       ├── kit/       # Composition of the shared modules (auth, vault, notify, backup, ...)
│   │       ├── db/        # Application tables and migrations
│   │       ├── routes/    # Endpoint handlers
│   │       ├── workers/   # Scheduler, checkers, notification events
│   │       └── services/  # Application services
│   ├── admin/         # Admin console (React): status-page pages on top of @better-kit/ui
│   ├── status/        # Public status page (React)
│   └── template/      # Minimal app built only from the shared modules
└── packages/
    ├── shared/        # Status-page types (@bsp/shared)
    └── …              # Shared modules (@better-kit/*): contracts, db, audit, auth, vault,
                       # notify, backup, config-as-code, runtime, ui
```

The shared modules hold everything that is not specific to a status page, so another product can be built on the
same foundation. See `CLAUDE.md` for the layering rules and how to start a new product from `apps/template`.

---

## Contributing 🤝

Found a bug? Have an idea? PRs are welcome — just open an issue first for anything bigger than a typo fix so we can discuss the approach.

1. Fork
2. `git checkout -b feature/your-idea`
3. Build something cool
4. Run `npm run lint && npm test && npm run build`
5. Open a PR

---

## License

MIT — do whatever you want. Just please don't set the status page font to Comic Sans. 😅

---

## ☕ Support

BetterStatusPage is completely free and open source. If you find it useful and want to support continued development, voluntary donations are appreciated but never required!

[![Buy Me A Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png)](https://buymeacoffee.com/belluu)

Your support helps keep the project alive and motivates continued development — but using BetterStatusPage, testing it, and sharing feedback is support enough!

---

<div align="center">
  <sub>Built with ☕, mild sleep deprivation, and a genuine hatred of status pages that lie.</sub>
</div>
