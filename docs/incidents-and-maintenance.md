# Incidents and maintenance

Monitors report what the checks see. Incidents and maintenance windows are what **you** tell visitors: an incident explains a problem and how it is going, a maintenance window announces planned work and keeps your notification channels quiet while it runs.

Both live under **Monitoring** in the admin console: **Incidents** and **Maintenance**.

## Who can manage them

Incidents and maintenance windows need the **operator** role or higher. The admin console hides both pages from other roles, and the API answers `403` to them (`/api/v1/admin/incidents` and `/api/v1/admin/maintenance` both require operator). See [Users and roles](users-and-roles.md).

| Role | Incidents and maintenance |
|---|---|
| admin | Full access |
| operator | Full access |
| branding | No access |
| viewer | No admin access; sees them on a [private status page](private-status-page.md) |

Every create, update and delete is written to the audit log.

---

## Incidents

### Creating an incident

*Admin → Incidents → **New Incident***

| Field | What it does |
|---|---|
| **Title** | Required. Shown on the status page, in feeds and in subscriber notifications. |
| **Status** | Where the incident starts: *Investigating* (default), *Identified* or *Monitoring*. |
| **Impact** | *Minor* (default), *Major* or *Critical*. Decides how linked monitors look on the status page. |
| **Affected Monitors** | The monitors the incident is about. Optional; an incident with none is page-wide. |
| **Notify subscribers** | On by default. See [Notifying subscribers](#notifying-subscribers). |

The start time is the moment you create the incident. The incident has no timeline entry yet; the first one appears with the first update you post.

### Statuses

An incident moves through four statuses. You can pick any of them with each update, in any order:

| Status | Meaning |
|---|---|
| `investigating` | Something is wrong and you are looking into it |
| `identified` | You know the cause |
| `monitoring` | A fix is in place and you are watching it |
| `resolved` | Over |

An incident counts as **active** until its status is `resolved`. The resolution time is stamped when the status first becomes `resolved`; the public page uses it to show how long the incident lasted.

### Impact

| Impact | Effect on linked monitors on the status page |
|---|---|
| `minor` | Shown as degraded |
| `major` | Shown as down |
| `critical` | Shown as down |

The incident only ever makes a monitor look **worse**: a monitor that is already down stays down under a minor incident. Monitoring itself is not affected — checks, uptime and alerts carry on as before — and resolving the incident brings back the status the checks report.

### Posting updates

Click an incident to expand it. The panel shows its affected monitors, the update timeline (newest first) and, while the incident is active, a **Post Update** box:

1. Describe the current situation.
2. Pick the new status. The incident takes this status.
3. Leave **Notify subscribers** on or switch it off, and click **Post Update**.

Picking **Resolved** resolves the incident. Once it is resolved the **Post Update** box disappears from the admin console.

### Editing and deleting

The admin console has no edit form. The API changes title, status, impact and resolution time, and replaces the linked monitors:

```http
PATCH /api/v1/admin/incidents/:id
{ "title": "Checkout errors", "impact": "major", "status": "resolved", "resolvedAt": 1758710400000 }

POST /api/v1/admin/incidents/:id/monitors
{ "monitorIds": [3, 7] }
```

Setting the status back from `resolved` to anything else clears the resolution time and makes the incident active again.

The delete button (bin icon) removes an incident with its whole timeline after a confirmation. Deleting does not notify anyone, and it cannot be undone.

### On the status page

Incidents are public as soon as they are created. Only monitors placed on the public page (in the Page Builder) are ever shown as affected; links to internal monitors are left out.

- **Incidents block.** Add an *Incidents* block in the Page Builder to show incidents. It can list active incidents, resolved ones, or both (the default), up to a set number (5 by default). See [Customizing the status page](customizing-the-status-page.md).
- **Active incident card.** Status badge, title, affected monitors and the four most recent updates. Times are shown in UTC.
- **Resolved incident row.** Date, title, *Resolved in …* with the duration, and the affected monitors. Click it to expand the full timeline.
- **Headline.** When the layout has an Incidents block and an incident is active, the page headline says incidents are in progress and counts them.
- **Monitor status.** Linked monitors change colour according to the impact, as described above.
- **Uptime bar.** Each day's tooltip lists the incidents linked to that monitor that were open that day.

The page updates live: creating, updating or resolving an incident is pushed to open status pages straight away.

### Feeds and the status API

- The [RSS and Atom feeds](subscriptions.md#feeds) list recently updated incidents with their update history.
- The [Slack feed](subscriptions.md#slack) posts one item per new incident, update and resolution.
- The [status API](subscriptions.md#status-api) lists unresolved incidents in `summary.json` and applies the same impact rule to component statuses in `components.json`.

### Notifying subscribers

When subscriptions are switched on (**Configure → Subscribers**), a **Notify subscribers** checkbox appears when you create an incident and when you post an update. It is on by default; switch it off to publish quietly, for a typo fix or an internal note.

| Action | Subscriber event |
|---|---|
| Create an incident | New incident |
| Post an update | Incident update |
| Post an update with status *Resolved* | Resolution (instead of an update) |

Who receives each event depends on the event types you allow, what each subscriber chose and the components they follow. An incident with no affected monitors goes to everyone who chose that event type. See [Who receives what](subscriptions.md#who-receives-what).

The checkbox only affects email and webhook subscribers. The feeds, Slack included, always mirror what is public on the page.

---

## Maintenance windows

### Scheduling a window

*Admin → Maintenance → **Schedule Maintenance***

| Field | What it does |
|---|---|
| **Name** | Required. Shown in the banner and in subscriber notifications. |
| **Description** | Optional. Shown next to the name on the status page. |
| **Starts At** / **Ends At** | Date, hour and minute. The end must be after the start. |
| **Affected Monitors** | The monitors under maintenance, or **All monitors**. |
| **Notify subscribers** | On by default; only offered when creating a window. |

The form opens with a window starting in one hour and lasting two.

**Times are entered in your browser's timezone** and stored as absolute points in time, so a colleague in another timezone sees the same window in their own local time. The status page shows the end time in the visitor's local time; subscriber notifications show both times in UTC.

> **Leave no monitor unticked by accident.** A window with no monitors selected is stored the same way as **All monitors**: it covers every monitor, whatever the hint under the list says.

### Active, Upcoming and Past

The Maintenance page sorts windows into three tabs, re-checked every 30 seconds:

| Tab | Windows |
|---|---|
| **Active** | Running now. Marked **ACTIVE** with a countdown and an **End now** button. |
| **Upcoming** | Not started yet |
| **Past** | Already over |

Each window shows its time range, duration and affected monitors. Use the pencil to edit any field, **End now** to finish a running window early (its end time is set to now), or the bin to delete it.

### What happens during a window

While a window is running, for every monitor it covers:

- **Checks keep running and are recorded.** The monitor's status on the status page and in the admin console follows the checks as usual, and failures inside the window count against uptime.
- **Notification channels stay silent.** Neither alerts nor recoveries are sent, and nothing is recorded in the delivery history for them. See [Notification channels](notification-channels.md).
- **Alert state is frozen.** After the window, the next check is compared with the status confirmed before it started. An outage that began during the window and is still going alerts once the window ends; a monitor that was already down and recovered during the window sends its recovery then. Problems that came and went inside the window are never alerted.

Certificate expiry warnings are not affected by maintenance windows.

On the status page:

- A **banner** at the top lists every running window with its name, description and end time.
- Each covered monitor card shows a **MAINTENANCE** chip.
- Upcoming windows are not shown on the page itself.

The [status API](subscriptions.md#status-api) lists running and upcoming windows in `summary.json` and reports covered components as `under_maintenance`.

A window that covers only monitors not placed on the public page is hidden everywhere public: no banner, no feed item, no API entry and no subscriber notification. It still silences notification channels.

### Notifying subscribers

With **Notify subscribers** on, creating a window sends a *Scheduled maintenance* event to subscribers who chose it, and the window appears in the [Slack feed](subscriptions.md#slack). It goes out once, when the window is created:

- Editing a window, ending it early or deleting it does not notify anyone.
- A window created with an end time already in the past is never announced.
- A window covering all monitors goes to every subscriber who chose maintenance events.

Scheduled maintenance does not appear in the RSS and Atom incident feeds.

---

## API

All endpoints need the operator role or higher, as a signed-in user or with an [API token](api.md), for example to [open an incident from a pipeline](api.md#open-an-incident-from-cicd). Timestamps are milliseconds since the epoch.

Incidents (`/api/v1/admin/incidents`):

| Method | Path | Body |
|---|---|---|
| GET | `/` | — (optional `?page=&limit=`) |
| POST | `/` | `{ title, status?, impact?, startedAt?, monitorIds?, notifySubscribers? }` |
| PATCH | `/:id` | `{ title?, status?, impact?, resolvedAt?, notifySubscribers? }` |
| DELETE | `/:id` | — |
| POST | `/:id/updates` | `{ body, status, notifySubscribers? }` |
| POST | `/:id/monitors` | `{ monitorIds }` — replaces the links |

`status` defaults to `investigating`, `impact` to `minor`, `startedAt` to now. A `PATCH` that changes the status to `resolved` sends a resolution to subscribers unless `notifySubscribers` is `false`.

Maintenance windows (`/api/v1/admin/maintenance`):

| Method | Path | Body |
|---|---|---|
| GET | `/` | — |
| GET | `/active` | — (windows running now) |
| GET | `/:id` | — |
| POST | `/` | `{ name, startsAt, endsAt, description?, monitorIds?, notifySubscribers? }` |
| PATCH | `/:id` | `{ name?, startsAt?, endsAt?, description?, monitorIds? }` |
| DELETE | `/:id` | — |

An empty or missing `monitorIds` means all monitors. A window needs a `name` (up to 200 characters), a `startsAt` and an `endsAt` that are positive millisecond timestamps with the end after the start (a `PATCH` that moves only one end is checked against the stored other end), a `description` that is text or `null`, and a `monitorIds` list of at most 1000 existing monitors; anything else is refused with `400`.
