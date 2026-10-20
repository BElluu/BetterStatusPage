# Comparison

How BetterStatusPage compares with other tools that monitor services, publish a status page, or both. Start with the table for a quick overview, then read the section for the product you are weighing it against.

> [!NOTE]
> The other products change faster than this page. The comparison reflects their publicly documented features, repositories and pricing pages as checked on 20 October 2026, and is written in good faith. Prices are in US dollars per month, as listed by the vendor, and leave out taxes and add-ons unless stated. Check the vendor's own site before you decide, and [open an issue](https://github.com/BElluu/BetterStatusPage/issues) if something here is out of date.

> [!WARNING]
> **Not released yet.** Recurring maintenance windows and the static fallback are not in a published release. To try them, build the image yourself from the `main` branch (see [Deployment](deployment.md)).

---

## At a glance

| | **BetterStatusPage** | **Gatus** | **Uptime Kuma** | **Statuspage** | **Instatus** | **Better Stack** | **Cachet** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Hosting** | Self-hosted | Self-hosted | Self-hosted | SaaS | SaaS | SaaS | Self-hosted |
| **License** | MIT | Apache 2.0 | MIT | Proprietary | Proprietary | Proprietary | Cachet license |
| **Price** | Free | Free | Free | Free plan, paid from $29 | Free plan, paid from $20 | Free plan, extras paid | Free |
| **Runs on** | Node.js, SQLite | Go binary | Node.js, SQLite or MariaDB | — | — | — | PHP and an SQL database |
| **Built-in monitoring** | ✓ | ✓ | ✓ | ✕ Manual or API | ✓ | ✓ | ✕ Manual or API |
| **Public status page** | ✓ Builder | ✓ Dashboard | ✓ Several pages | ✓ | ✓ | ✓ | ✓ |
| **Incidents and updates** | ✓ | • Notices | • Pinned posts | ✓ | ✓ | ✓ | ✓ |
| **Scheduled maintenance** | ✓ Recurring | • Silences alerts | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Subscribers** | ✓ Email, webhook, RSS, Slack | ✕ | • RSS | ✓ Email, SMS, Slack | ✓ Email, Slack, Teams | ✓ Email, RSS, more | • Email |
| **Private status page** | ✓ Whole page | • Whole dashboard | ✕ | ✓ From $79 | ✓ Paid plans | ✓ From $50 | — |
| **Configuration as code** | ✓ YAML | ✓ YAML only | ✕ | • API | • API | ✓ Terraform | • API |
| **Edited in a web UI** | ✓ | ✕ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Page when the server is down** | ✓ Static fallback | ✕ | ✕ | ✓ Vendor hosts it | ✓ Vendor hosts it | ✓ Vendor hosts it | ✕ |

✓ yes · • partly, see the section below · ✕ no, or not in the documentation · — does not apply or not checked

For the people side of the self-hosted tools:

| | **BetterStatusPage** | **Gatus** | **Uptime Kuma** | **Cachet** |
| --- | --- | --- | --- | --- |
| **Notification providers for your team** | 8 | 40+ | 90+ | — |
| **Accounts** | Four roles: admin, operator, branding, viewer | None; one Basic login or OIDC for the whole dashboard | One administrator login | Two levels: admin and user |
| **Single sign-on** | OIDC | OIDC | — | — |
| **API** | Tokens limited to chosen parts | Read-only, plus a push endpoint | Badges, push and status page data | Keys with chosen permissions |

---

## Which one fits

- **You want a status page and monitoring in one self-hosted place, with accounts, roles and an audit trail**: BetterStatusPage.
- **You want the whole setup as a YAML file in Git and nothing else**: Gatus.
- **You want the largest list of monitor types and notification providers in a simple UI, for one person or a small group**: Uptime Kuma.
- **You would rather pay than run a server, and you need on-call, SMS or phone calls**: Atlassian Statuspage, Instatus or Better Stack.

None of these is a verdict. If a product on this page fits better, use it.

---

## Gatus

[Gatus](https://github.com/TwiN/gatus) is a health dashboard that is configured entirely by a YAML file. You list endpoints and the conditions that make them healthy (`[STATUS] == 200`, `[RESPONSE_TIME] < 300`, `[BODY].status == UP`), and Gatus checks them and shows the results on one page. It is licensed under Apache 2.0 and written in Go.

**Where Gatus is stronger**

- **Conditions.** Its condition language is expressive: status, response time, body fields, the target IP, certificate expiry and domain expiry can be combined in one check. BetterStatusPage covers [status code, keyword, header and JSON field checks](monitors.md#response-checks), but Gatus is the more flexible tool if your checks are mostly assertions on responses.
- **Weight.** A single Go binary; its documentation calls the resource footprint "negligibly small". BetterStatusPage needs Node.js 26.
- **Git first.** There is no database to export and no UI that can drift from the file. Changes are reviewed as pull requests, and Gatus reloads the file on the fly when it changes.
- **Protocols.** HTTP, TCP, UDP, SCTP, ICMP, DNS, TLS, SSH, STARTTLS, gRPC and WebSocket checks, and domain expiry. *Suites* of dependent checks (marked alpha) and *external endpoints* that other systems push their status to.
- **Notification providers.** More than 40, against 8 in BetterStatusPage.
- **Metrics.** A Prometheus endpoint and badges for uptime and response time.

**Where BetterStatusPage is stronger**

- **A status page for other people.** In Gatus the dashboard is the status page: it shows endpoints grouped by name, with their recent results. BetterStatusPage has a [page builder](customizing-the-status-page.md) (monitors, groups, charts, text, branding, dark mode, translations), [incidents with updates and impact](incidents-and-maintenance.md), and [subscriptions](subscriptions.md) by email, webhook, RSS and Slack. Gatus offers *announcements* (the “Notices” in the table), messages at the top of the dashboard, but no subscribers.
- **A web UI for operators.** Nothing changes in BetterStatusPage until someone presses Save, and a **Test** button runs a monitor before it is stored. In Gatus every change is an edit to the file. If you want that, it is a feature; if your colleagues do not use Git, it is not.
- **People and access.** [Users with roles](users-and-roles.md), [OIDC single sign-on](single-sign-on.md) and two-factor sign-in, [API tokens](api.md) limited to the parts they need, and an audit log of who changed what. Gatus has Basic authentication and OIDC for the whole dashboard, and no accounts.
- **Secrets.** Credentials go to an [encrypted vault](vault.md) (or HashiCorp Vault) and are referenced by name. Gatus reads values from the file and from environment variables.
- **Alert hygiene.** [Quiet hours, rate caps and grouping](alert-hygiene.md) per channel, with a delivery history that records what was held back and why. Gatus alerts after a number of failures and recoveries in a row.
- **Maintenance.** [Several windows, one-off or recurring](incidents-and-maintenance.md#maintenance-windows), shown as a banner on the status page, with failed checks kept out of the uptime figures. In Gatus a recurring window keeps alerts quiet.
- **Actions.** [Send an HTTP request](actions.md) when a monitor stays down, for example to start a failover job.
- **Operations.** [Backup and restore](backup-restore.md), an [uptime report](reports.md) and a [static fallback](static-fallback.md) that keeps the page up when your server is not.

**Using both.** Gatus works well as a second opinion running on another machine. Its `custom` alert provider can call a BetterStatusPage [webhook monitor](monitors.md#reporting-a-failure), so the page can show that the watcher itself is alive.

**Choose Gatus if** your configuration already lives in Git, nobody needs to edit it from a browser, and the dashboard is enough for your audience. **Choose BetterStatusPage if** you also publish incidents to customers, need accounts and an audit trail, or want people who do not use Git to run it.

---

## Uptime Kuma

[Uptime Kuma](https://github.com/louislam/uptime-kuma) is the most popular self-hosted uptime monitor (MIT, JavaScript): a polished web UI, a long list of monitor types and more than 90 notification providers.

**Where Uptime Kuma is stronger**

- **Breadth.** More monitor types than BetterStatusPage, among them gRPC, MQTT, Redis, RabbitMQ, Kafka, SNMP, NTP, RADIUS, SMTP, SFTP, game servers (GameDig and Steam) and real browser checks, and many more notification providers. Setup is a single container.
- **Community.** The largest of the projects here, with many guides and integrations.
- **Several status pages.** Each can be mapped to its own domain.

**Where BetterStatusPage is stronger**

- **Accounts.** Uptime Kuma has a single administrator login, and user management is an open feature request. BetterStatusPage has [roles](users-and-roles.md) (admin, operator, branding and viewer), [single sign-on](single-sign-on.md), [API tokens](api.md) with permissions and an audit log.
- **Audience.** [Subscriptions](subscriptions.md) by email, webhook, RSS and Slack, with confirmation by email. A Kuma status page offers an RSS feed and no other way to subscribe.
- **Incidents.** A Kuma incident is one pinned post that you edit; BetterStatusPage has impact levels, linked monitors, updates over time, [automatic incidents](incidents-and-maintenance.md#automatic-incidents) written from templates, and a [recurring maintenance window](incidents-and-maintenance.md#recurring-windows) that keeps uptime clean.
- **Alert hygiene and actions.** [Quiet hours, rate caps, grouping](alert-hygiene.md) and [HTTP actions](actions.md).
- **Secrets and code.** An [encrypted vault](vault.md) and [YAML import and export](configuration-as-code.md), with optional pruning. Uptime Kuma is configured in the UI.
- **Private page.** The [whole page behind sign-in](private-status-page.md), with a viewer role. Uptime Kuma status pages are public.
- **Operations.** Built-in [backup and restore](backup-restore.md) and a [static fallback](static-fallback.md).

**Choose Uptime Kuma if** you are one person or a small group who wants the most monitor types and providers with the least setup. **Choose BetterStatusPage if** more than a few people touch it, you need roles and an audit trail, or your audience should be able to subscribe.

---

## Atlassian Statuspage

[Statuspage](https://www.atlassian.com/software/statuspage) is a hosted status page service. It is the best known, and it does not run checks of its own: incidents are created by hand, through its APIs or through integrations, and performance metrics come from tools such as Datadog or New Relic.

**Where Statuspage is stronger**

- **Nothing to run.** The page is hosted by the vendor, so it stays up when your infrastructure does not.
- **Reach.** Subscribers by email, SMS, Slack and webhook, with Microsoft Teams as an integration. SMS and webhook delivery start on the $99 plan.
- **Scale.** Plans go from 100 subscribers on the free plan to 25,000 on the $1,499 plan, with component subscriptions and role-based access on the higher ones.
- **Ecosystem.** Integrations with other Atlassian products and many monitoring tools.

**Where BetterStatusPage is stronger**

- **Monitoring is included.** Statuses follow the checks, with no separate tool and no glue code.
- **Cost.** Statuspage is priced by subscribers and features. A custom domain starts at $29, SSO through Atlassian Guard at $99, and a private page is a separate product from $79. BetterStatusPage has no plans, and the whole feature set is free.
- **Control of data.** Your incidents, subscriber list and history stay on your server.
- **Automation.** [Automatic incidents](incidents-and-maintenance.md#automatic-incidents), [actions](actions.md) and [configuration as code](configuration-as-code.md).

**What it costs you to move.** You run the server, patch it and back it up (there is [built-in backup](backup-restore.md)). Use the [static fallback](static-fallback.md) so that visitors still get a page when your host is down. BetterStatusPage has no SMS channel.

---

## Instatus

[Instatus](https://instatus.com) is a hosted status page with built-in monitoring, aimed at fast setup and a modern look.

**Where Instatus is stronger**

- **Hosted and quick.** A page in minutes, a custom domain on the Pro plan, and no server to keep alive.
- **SMS and phone calls** for alerts: SMS from the Pro plan ($20), calls on Business.
- **Checks every 30 seconds** on paid plans (every 2 minutes on the free plan).
- **Subscribers in Slack and Microsoft Teams** through webhooks, next to email.

**Where BetterStatusPage is stronger**

- **No limits to buy.** Instatus plans cap monitors (15 free, 50 on Pro, 1,000 on Business) and subscribers (200, 5,000 and 25,000). BetterStatusPage has no such limits and no plans.
- **Private pages and SSO.** In Instatus a private page needs a Private Pro or Business plan, and SAML single sign-on needs Business. BetterStatusPage includes a [private page](private-status-page.md) and [OIDC](single-sign-on.md).
- **Depth of monitoring.** Database and Docker monitors, [authentication flows](monitors.md#https-authentication), [response checks](monitors.md#response-checks), [certificate expiry warnings](monitors.md#tls-certificate-expiry-warnings) and [dependencies](monitors.md#dependencies).
- **Control of data and access.** Self-hosted, with [roles](users-and-roles.md) and an audit log included.
- **Alert hygiene, actions and configuration as code.** See [Alert hygiene](alert-hygiene.md), [Actions](actions.md) and [Configuration as code](configuration-as-code.md).

**What it costs you to move.** You run the server and bring your own SMTP for email. There is no SMS channel.

---

## Better Stack

[Better Stack](https://betterstack.com) is a hosted platform: uptime monitoring and a status page are one product among logs, tracing and on-call.

**Where Better Stack is stronger**

- **A whole platform.** On-call scheduling, phone and SMS alerts and incident management in one place; logs and error tracking if you want them.
- **Locations.** Multi-location checks, so you see problems that depend on where you look from, and checks as often as every 30 seconds.
- **Browser checks.** Scripted Playwright checks, billed by the minute.
- **Terraform.** A provider for monitors and status pages.
- **Nothing to host,** and the page stays up when you are down.

**Where BetterStatusPage is stronger**

- **Cost and limits.** The free plan has 10 monitors and one status page. More monitors, extra pages, password protection ($50 per page), SSO ($250 per page) and audit logs ($250) are billed on top. BetterStatusPage includes all of it for free.
- **Data stays with you.** Targets on a private network can be checked without opening them to a vendor, and secrets are in your own [vault](vault.md).
- **Simplicity.** One process, one database file, no account with a vendor.

**What it costs you to move.** Checks run from your server only, and there is no on-call rota, escalation or phone alerting; send alerts to a tool that does that through a [webhook channel](notification-channels.md).

---

## Cachet

[Cachet](https://github.com/cachethq/cachet) is a self-hosted status page written in PHP (Laravel). Its current line is 3.x: components, incidents with updates, scheduled maintenance, metrics, email subscribers, webhooks, an API and users. Its documentation describes no checks of its own, so something else has to update the status.

**Where Cachet is stronger**

- **Simple model.** If you only need components and incident posts, with checks done elsewhere, it is small and familiar to PHP shops.
- **Metrics.** Custom metrics displayed on the page.
- **Databases.** MariaDB, MySQL, PostgreSQL or SQLite.

**Where BetterStatusPage is stronger**

- **Monitoring is included,** so the page follows the checks without scripts that call an API.
- **Everything around the page.** A private page, four roles, single sign-on, an audit log, backup, actions and configuration as code.

**Before you pick it,** look at the state of the project. The 3.x documentation says it is under active development and incomplete, and the migration guide says the path from Cachet 2.4 is incomplete and warns against running migrations on a 2.4 database. The newest published GitHub release is still 2.4.1, from November 2023. The license is Cachet's own text, which lets you use it commercially but allows distribution only as part of another application; read it before you rely on it.

---

## Moving to BetterStatusPage

- **Monitors, channels and actions** can be written as [YAML documents](configuration-as-code.md) and imported, so a list exported or copied from another tool can be turned into one file with a script.
- **A Gatus file** maps closely: an endpoint becomes an HTTPS, Ping / TCP or DNS monitor, its `conditions` become [response checks](monitors.md#response-checks) where BetterStatusPage has an equivalent, and its `alerts` become [notification channels](notification-channels.md) with failure and recovery thresholds.
- **Subscribers** cannot be imported by anyone but the subscriber, because they confirm by email; announce the new page and ask them to subscribe.

Ready to try it? Start with [Deployment](deployment.md).

---

## Sources

Checked on 20 October 2026: the repositories and documentation of [Gatus](https://github.com/TwiN/gatus), [Uptime Kuma](https://github.com/louislam/uptime-kuma) and [Cachet](https://cachethq.io/docs); the pricing pages of [Statuspage](https://www.atlassian.com/software/statuspage/pricing), [Instatus](https://instatus.com/pricing) and [Better Stack](https://betterstack.com/pricing); and the help pages of [Instatus](https://instatus.com/help) and [Better Stack](https://betterstack.com/docs/uptime/subscribing-to-status-updates/).
