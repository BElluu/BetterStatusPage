# BetterStatusPage vs Gatus, Uptime Kuma and other status page tools

How BetterStatusPage compares with Gatus, Uptime Kuma, Statuspage, Instatus, Better Stack and Cachet, and which one fits your case.

> [!NOTE]
> Compared on 20 October 2026, from each product's public documentation, repository and pricing page, in good faith. Prices, plan limits and provider counts change often, so this page leaves them out on purpose: check the vendor's own site for those. [Open an issue](https://github.com/BElluu/BetterStatusPage/issues) if something here is wrong.

> [!WARNING]
> **Not released yet.** Recurring maintenance windows and the static fallback are not in a published release. To try them, build the image yourself from the `main` branch (see [Deployment](deployment.md)).

---

## Which one fits

| You want… | Choose |
| --- | --- |
| A status page **and** monitoring in one self-hosted place, with accounts, roles and an audit trail | **BetterStatusPage** |
| A single config file as the only way to set things up, no database, and a plain dashboard | [Gatus](#betterstatuspage-vs-gatus) |
| The most monitor types and notification providers, in a simple UI for one person or a small group | [Uptime Kuma](#betterstatuspage-vs-uptime-kuma) |
| Someone else to host the page, with SMS or phone alerts | Atlassian Statuspage, Instatus or Better Stack |
| A status page that something else feeds through an API | Cachet |

None of these is a verdict. If another product fits better, use it.

---

## At a glance

| | **BetterStatusPage** | **Gatus** | **Uptime Kuma** | **Statuspage** | **Instatus** | **Better Stack** | **Cachet** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Hosting** | Self-hosted | Self-hosted | Self-hosted | SaaS | SaaS | SaaS | Self-hosted |
| **License** | MIT | Apache 2.0 | MIT | Proprietary | Proprietary | Proprietary | Cachet license |
| **Price** | Free | Free | Free | Free plan, paid plans | Free plan, paid plans | Free plan, paid extras | Free |
| **Built-in monitoring** | ✓ | ✓ | ✓ | ✕ Manual or API | ✓ | ✓ | ✕ Manual or API |
| **Public status page** | ✓ Builder | ✓ Dashboard | ✓ Several pages | ✓ | ✓ | ✓ | ✓ |
| **Incidents and updates** | ✓ | • Notices | • Pinned posts | ✓ | ✓ | ✓ | ✓ |
| **Scheduled maintenance** | ✓ Recurring | • Silences alerts | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Subscribers** | ✓ Email, webhook, RSS, Slack | ✕ | • RSS | ✓ Email, SMS, Slack | ✓ Email, Slack, Teams | ✓ Email, webhook, RSS | • Email |
| **Private status page** | ✓ Whole page | • Whole dashboard | ✕ | ✓ Paid plan | ✓ Paid plan | ✓ Paid extra | — |
| **Single sign-on** | ✓ OIDC | • Whole dashboard | — | ✓ Paid plan | ✓ Paid plan | ✓ Paid extra | — |
| **SMS notifications** | ✕ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| **Configuration as code** | ✓ YAML | ✓ YAML only | ✕ | • API | • API | ✓ Terraform | • API |
| **Edited in a web UI** | ✓ | ✕ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Page when the server is down** | ✓ Static fallback | ✕ | ✕ | ✓ Vendor hosts it | ✓ Vendor hosts it | ✓ Vendor hosts it | ✕ |

✓ yes · • partly, the note says how · ✕ no, or not in the documentation · — does not apply or not checked

Hosted services (Statuspage, Instatus, Better Stack) mean nothing to run and a page that stays up when you are down; the price is plan limits, extras billed on top and your data on their servers. Moving from one means you run, patch and [back up](backup-restore.md) a server, and there is no phone channel. Cachet publishes a page but runs no checks, so something else has to feed it; read its current license text and release status before you pick it.

---

## BetterStatusPage vs Gatus

[Gatus](https://github.com/TwiN/gatus) is a health dashboard configured entirely by a YAML file: you list endpoints and the conditions that make them healthy, and it shows the results on one page.

**Gatus is stronger at** conditions (status, response time, body fields and certificate expiry in one check), more protocols (UDP, SSH, gRPC and others), more notification providers, and weight: one small Go binary, no database, and it reloads the file on the fly.

**BetterStatusPage is stronger at**

- **A status page for other people.** Gatus has a dashboard and *announcements*. BetterStatusPage has a [page builder](customizing-the-status-page.md), [incidents with updates](incidents-and-maintenance.md) and [subscriptions](subscriptions.md) by email, webhook, RSS and Slack.
- **A web UI, and a file if you want one.** Edit and **Test** in the browser, or keep monitors, channels and actions in YAML and [import them](configuration-as-code.md) through the UI or the API, with optional pruning so Git stays the source of truth.
- **People, secrets and operations.** [Roles](users-and-roles.md), [OIDC](single-sign-on.md), [API tokens](api.md), an audit log, an [encrypted vault](vault.md), [quiet hours and rate caps](alert-hygiene.md), [HTTP actions](actions.md), [backup and restore](backup-restore.md) and a [static fallback](static-fallback.md). Gatus has no accounts.

**Choose Gatus if** you want one file as the only configuration and a dashboard is enough. **Choose BetterStatusPage if** you publish incidents to customers or need accounts and an audit trail. They also work together: Gatus can call a BetterStatusPage [webhook monitor](monitors.md#reporting-a-failure) to show that the watcher is alive.

**Coming from Gatus,** an endpoint maps to an HTTPS, Ping / TCP or DNS monitor, its `conditions` to [response checks](monitors.md#response-checks) where there is an equivalent, and its `alerts` to [notification channels](notification-channels.md). Write them as [YAML documents](configuration-as-code.md) and import them.

---

## BetterStatusPage vs Uptime Kuma

[Uptime Kuma](https://github.com/louislam/uptime-kuma) is the most popular self-hosted uptime monitor: a polished web UI, many monitor types and a very long list of notification providers.

**Uptime Kuma is stronger at** breadth (more monitor types, for example gRPC, MQTT, Redis and game servers, and many more notification providers), a large community, and several status pages each mapped to its own domain.

**BetterStatusPage is stronger at**

- **Accounts.** Kuma has one administrator login. BetterStatusPage has [roles](users-and-roles.md), [single sign-on](single-sign-on.md), [API tokens](api.md) and an audit log.
- **Audience and incidents.** [Subscriptions](subscriptions.md) by email, webhook, RSS and Slack (Kuma offers RSS), and incidents with [updates over time](incidents-and-maintenance.md) instead of one pinned post.
- **Alerts, secrets and operations.** [Quiet hours and rate caps](alert-hygiene.md), [HTTP actions](actions.md), an [encrypted vault](vault.md), [YAML import and export](configuration-as-code.md), a [private page](private-status-page.md) behind sign-in, [backup and restore](backup-restore.md) and a [static fallback](static-fallback.md).

**Choose Uptime Kuma if** you are one person or a small group who wants the most monitor types with the least setup. **Choose BetterStatusPage if** more than a few people touch it or your audience should be able to subscribe.

---

## Moving to BetterStatusPage

- **Monitors, channels and actions** can be written as [YAML documents](configuration-as-code.md) and imported, so a list exported from another tool can become one file with a script.
- **Subscribers** cannot be imported, because they confirm by email. Announce the new page and ask them to subscribe.

Ready to try it? Start with [Deployment](deployment.md).

---

## Sources

[Gatus](https://github.com/TwiN/gatus), [Uptime Kuma](https://github.com/louislam/uptime-kuma) and [Cachet](https://cachethq.io/docs) repositories and documentation; [Statuspage](https://www.atlassian.com/software/statuspage/pricing), [Instatus](https://instatus.com/pricing) and [Better Stack](https://betterstack.com/pricing) pricing pages; [Instatus](https://instatus.com/help) and [Better Stack](https://betterstack.com/docs/uptime/subscribing-to-status-updates/) help pages. Checked on 20 October 2026.
