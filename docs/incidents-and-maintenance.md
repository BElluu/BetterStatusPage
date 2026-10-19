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
| **Start from template** | Optional. Fills the title and impact from an [incident template](#incident-templates); `{{monitor}}` becomes the names of the monitors you ticked. |
| **Save as draft** | Keeps the incident visible to operators only until you publish it. See [Drafts](#drafts). |
| **Notify subscribers** | On by default. See [Notifying subscribers](#notifying-subscribers). Not shown for a draft. |

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

Incident templates (`/api/v1/admin/incident-templates`, same permission):

| Method | Path | Body |
|---|---|---|
| GET | `/` | — |
| POST | `/` | `{ name, title, body, resolvedBody, impact, translations? }` — all but `translations` required |
| PATCH | `/:id` | any of those; `translations` replaces all translations |
| DELETE | `/:id` | — (`409` for the default template) |

A duplicate `name` is refused with `409`.

### Editing and deleting

The admin console has no edit form. The API changes title, status, impact and resolution time, and replaces the linked monitors:

```http
PATCH /api/v1/admin/incidents/:id
{ "title": "Checkout errors", "impact": "major", "status": "resolved", "resolvedAt": 1758710400000 }

POST /api/v1/admin/incidents/:id/monitors
{ "monitorIds": [3, 7] }
```

Setting the status back from `resolved` to anything else clears the resolution time and makes the incident active again. Changing the title of an [automatic incident](#automatic-incidents) removes its translated titles.

The delete button (bin icon) removes an incident with its whole timeline after a confirmation. Deleting does not notify anyone, and it cannot be undone.

### Drafts

A draft is an incident that only the admin console shows. It is left out of the status page, the feeds, the status API and the live updates, and nobody is notified about it. Everything else works as usual: you can edit it, post updates and link monitors.

**Publish** (on the incident's row) makes it public and notifies subscribers as for a new incident, or as for a resolution when the draft is already resolved. Publishing cannot be undone: a published incident cannot go back to a draft. Deleting a draft is silent.

### On the status page

Incidents are public as soon as they are created, unless they are [drafts](#drafts). Only monitors placed on the public page (in the Page Builder) are ever shown as affected; links to internal monitors are left out.

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

When subscriptions are switched on (**Status page → Subscribers**), a **Notify subscribers** checkbox appears when you create an incident and when you post an update. It is on by default; switch it off to publish quietly, for a typo fix or an internal note.

| Action | Subscriber event |
|---|---|
| Create an incident | New incident |
| Post an update | Incident update |
| Post an update with status *Resolved* | Resolution (instead of an update) |
| Publish a [draft](#drafts) | New incident (or resolution, if the draft is already resolved) |

Who receives each event depends on the event types you allow, what each subscriber chose and the components they follow. An incident with no affected monitors goes to everyone who chose that event type. See [Who receives what](subscriptions.md#who-receives-what).

The checkbox only affects email and webhook subscribers. The feeds, Slack included, always mirror what is public on the page.

### Automatic incidents

A monitor can open an incident by itself when it stays down, and close it again after it recovers. This is off by default; switch it on in the **Incident** side tab of the monitor's form.

| Setting | What it does |
|---|---|
| **Open an incident when this monitor stays down** | Turns the feature on for this monitor. |
| **Down for (minutes)** | How long the outage must last before the incident opens. `1`–`10080` (7 days). |
| **Create as** | *Draft* (default): operators review it and press **Publish**. *Published right away*: visitors and subscribers see it immediately. |
| **Template** | The [template](#incident-templates) that writes the incident. Empty means the default template. |

How it works:

- The clock starts when the monitor's failure is **confirmed**, so [Alert after (checks)](alert-hygiene.md#failure-and-recovery-thresholds) applies first. Only a *down* status counts, not *degraded*. While a [maintenance window](#maintenance-windows) is running nothing is opened or resolved; the outage is judged again after it.
- The incident starts at the moment the outage was confirmed, has the monitor linked and the template's opening message as its first update. There is at most one open automatic incident per monitor.
- When the monitor recovers (after [Recover after (checks)](alert-hygiene.md#failure-and-recovery-thresholds)), the incident gets the template's resolved message and is set to *Resolved*. A draft is resolved too, and stays a draft. If you resolve it yourself while the outage goes on, it is not opened again for that outage.
- Switching the feature off does not touch an incident that is already open; it is still closed on recovery. An outage that ends before the time you set creates nothing.
- **Published** only applies to monitors shown on the public status page. For an internal monitor the incident is always created as a draft, because its name would be public otherwise. The `{{error}}` placeholder is filled only in a draft: check errors can contain hostnames or credentials, so a published incident leaves it empty.
- If you delete the incident during the outage, the next check opens it again. Deleting a monitor leaves its open incident as it is; resolve it by hand.
- The settings can also be written in a [configuration file](configuration-as-code.md#automatic-incidents). Draft incidents are counted in the admin-only incident figures of reports and of the monitor page.
- Setting **Published** or a template through the API with a token needs the `incidents:write` permission as well as `monitors:write`.
- Automatic incidents are marked **automatic** in the list. Subscribers are notified only for a published one, as for any other incident.

### Incident templates

*Admin → Incidents → **Templates*** lists the templates; **New template** creates one. A template holds the incident **title**, an **opening message**, a **resolved message** and the **impact**. These placeholders are replaced:

| Placeholder | Replaced with |
|---|---|
| `{{monitor}}` | The monitor's name. |
| `{{duration}}` | How long the outage lasted so far, such as `7 min` or `1 h 5 min`. |
| `{{error}}` | The last error of the check (opening message only). |
| `{{status}}` | `down` in the opening message, `up` in the resolved message. |

An unknown placeholder is left as written, so a typo is easy to see. Template names are unique, because [configuration files](configuration-as-code.md#automatic-incidents) refer to a template by name.

The built-in **Default** template is used by every monitor that has no template of its own. You can edit it but not delete it. Deleting another template sends the monitors that used it back to the default one.

| | Title | Opening message |
|---|---|---|
| **Default** | `{{monitor}} is unavailable` | `We detected that {{monitor}} has been unavailable for {{duration}}. We are investigating.` |

#### Translations

The text of a template is in the **default language** of the status page. Under it, the editor has a block for every other language you added in [Languages](customizing-the-status-page.md#languages): fill in the title, the opening message and the resolved message for the ones you want. Placeholders work in every language.

When an automatic incident opens, each language that has wording gets its own copy, and a visitor who switches the status page to that language sees the title and the messages in it. A language, or a single field, left empty shows the default text. The copies are stored with the incident, so changing a template later does not touch incidents that already exist. If you rewrite the title of an automatic incident by hand, its translated titles are dropped, so a stale translation never contradicts the new title. Emails, feeds and webhooks always use the default-language text.

The **Start from template** list in *New Incident* takes the title and impact only; it does not post messages.

---

## Maintenance windows

### Scheduling a window

*Admin → Maintenance → **Schedule Maintenance***

| Field | What it does |
|---|---|
| **Name** | Required. Shown in the banner and in subscriber notifications. |
| **Description** | Optional. Shown next to the name on the status page. |
| **Starts At** / **Ends At** | Date, hour and minute. The end must be after the start. For a repeating window this is the first occurrence, and its length is the length of every occurrence. With weekdays chosen, the first run is the first chosen weekday on or after **Starts At**. |
| **Repeat** | **Does not repeat** (default), **Every day**, or **On selected weekdays** (tick the days). |
| **Repeat until** | Optional, for a repeating window: no occurrence starts after this time. Empty = repeats without end. |
| **Affected Monitors** | The monitors under maintenance, or **All monitors**. |
| **Notify subscribers** | On by default; only offered when creating a window. |

The form opens with a window starting in one hour and lasting two.

**Times are entered in your browser's timezone** and stored as absolute points in time, so a colleague in another timezone sees the same window in their own local time. The status page shows the end time in the visitor's local time; subscriber notifications show both times in UTC.

### Recurring windows

> [!WARNING]
> **Not released yet.** Recurring maintenance windows are not in a published release. To try them, build the image yourself from the `main` branch (see [Deployment](deployment.md)).

A repeating window is one entry that runs again at the same time of day, for example every night from 01:00 to 02:00, or every Tuesday from 02:00 to 03:00. It starts with the **Starts At** you entered and never before it.

- **The time of day is kept in the timezone of the browser that created the window**, shown next to the repeat rule on the Maintenance page. 01:00 stays 01:00 across a daylight-saving change.
- The Maintenance page shows the running or next occurrence. A repeating window is under **Past** only after **Repeat until** has gone by.
- **End now** on a repeating window ends only the occurrence that is running, for the time the work really takes. The next occurrence runs as scheduled, and from that moment the covered monitors are no longer silenced and their checks count towards uptime again.
- Editing a window changes all later occurrences; there are no other per-occurrence exceptions. An early end that was already pressed stays for that occurrence.
- **An occurrence may not overlap the next one**: at most 23 hours for **Every day**, and for weekdays at most an hour less than the shortest gap between two chosen days (a single weekday allows just under 7 days). The hour keeps it true on a day when the clocks go forward. The form refuses a longer window. **Repeat until** cannot be before **Starts At**.
- **A change of clocks does not move the window**: a window at 00:30 runs every local night, including the night when the clocks change. If the chosen time does not exist that night, it runs at the nearest valid moment.
- Subscribers are told once, when the window is created and has an occurrence running or still to come (also when its first date is in the past); later occurrences are not announced again. The status page banner, the status API and the Slack feed show the running occurrence.

> **Leave no monitor unticked by accident.** A window with no monitors selected is stored the same way as **All monitors**: it covers every monitor, whatever the hint under the list says.

### Active, Upcoming and Past

The Maintenance page sorts windows into three tabs, re-checked every 30 seconds:

| Tab | Windows |
|---|---|
| **Active** | Running now. Marked **ACTIVE** with a countdown and an **End now** button. |
| **Upcoming** | Not started yet |
| **Past** | Already over |

Each window shows its time range, duration and affected monitors. Use the pencil to edit any field, **End now** to finish a running window early (a one-off window's end time is set to now; a repeating window ends only the running occurrence), or the bin to delete it.

### What happens during a window

> [!WARNING]
> **Not released yet.** The *Maintenance* and *Incident* chips in the admin console are not in a published release. To try them, build the image yourself from the `main` branch (see [Deployment](deployment.md)).

In the admin console a covered monitor shows a **Maintenance** chip, and a monitor named by an open, published incident shows **Incident · minor / major / critical** (the worst impact if several are open; drafts are not counted), beside its status on the **Monitors** list, the **Dashboard** and the monitor's page. The monitor's page also has a **Maintenance** card listing the running and upcoming windows that cover it (the running or next occurrence of a repeating window, with its rule), with a link to the Maintenance page. They update every 30 seconds.

> [!WARNING]
> **Not released yet.** Leaving failed checks out of uptime is not in a published release. To try it, build the image yourself from the `main` branch (see [Deployment](deployment.md)).

While a window is running, for every monitor it covers:

- **Checks keep running and are recorded.** The monitor's status on the status page and in the admin console follows the checks as usual, and the admin console marks failures inside the window as *maintenance*. **Failed checks inside the window are left out of uptime** (status page bars, monitor statistics and the uptime report), so planned work does not lower it; checks that succeed inside the window still count. Only results recorded after this change are affected. A day on the uptime bar that has nothing but such failed checks is shown as **Maintenance** (blue) instead of *No data*, on the status page and in the monitor's page in the admin console.
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

All endpoints need the operator role or higher as a signed-in user, or an [API token](api.md#permissions) with `incidents` (or `maintenance`) permission, `write` to change and `read` to look, for example to [open an incident from a pipeline](api.md#open-an-incident-from-cicd). Timestamps are milliseconds since the epoch.

Incidents (`/api/v1/admin/incidents`):

| Method | Path | Body |
|---|---|---|
| GET | `/` | — (optional `?page=&limit=`) |
| POST | `/` | `{ title, status?, impact?, startedAt?, monitorIds?, notifySubscribers?, draft? }` |
| PATCH | `/:id` | `{ title?, status?, impact?, resolvedAt?, notifySubscribers?, draft? }` — `draft: false` publishes a draft |
| DELETE | `/:id` | — |
| POST | `/:id/updates` | `{ body, status, notifySubscribers? }` |
| POST | `/:id/monitors` | `{ monitorIds }` — replaces the links |

`status` defaults to `investigating`, `impact` to `minor`, `startedAt` to now and `draft` to `false`. A published incident cannot be set back to `draft: true` (`400`). A `PATCH` that changes the status to `resolved` sends a resolution to subscribers unless `notifySubscribers` is `false`.

Maintenance windows (`/api/v1/admin/maintenance`):

| Method | Path | Body |
|---|---|---|
| GET | `/` | — |
| GET | `/active` | — (windows running now) |
| GET | `/:id` | — |
| POST | `/:id/end` | — (ends the running occurrence now; `409` when the window is not running) |
| POST | `/` | `{ name, startsAt, endsAt, description?, recurrence?, recurrenceDays?, timezone?, recurrenceUntil?, monitorIds?, notifySubscribers? }` |
| PATCH | `/:id` | `{ name?, startsAt?, endsAt?, description?, recurrence?, recurrenceDays?, timezone?, recurrenceUntil?, monitorIds? }` |
| DELETE | `/:id` | — |

An empty or missing `monitorIds` means all monitors. A window needs a `name` (up to 200 characters), a `startsAt` and an `endsAt` that are positive millisecond timestamps with the end after the start (a `PATCH` that moves only one end is checked against the stored other end), a `description` that is text or `null`, and a `monitorIds` list of at most 1000 existing monitors; anything else is refused with `400`.

`recurrence` is `none` (default), `daily` or `weekly`. A `weekly` window needs `recurrenceDays`, a list of weekdays from `0` (Sunday) to `6`. `timezone` is an IANA name (default `UTC`) in which the time of day of `startsAt` is read. `recurrenceUntil` is a millisecond timestamp, not before `startsAt`, or `null`. An occurrence may not be longer than 23 hours for `daily`, nor longer than an hour less than the shortest gap between the chosen weekdays for `weekly` (`400` otherwise). Every response carries `occurrence` (`startsAt` and `endsAt` of the running, else the next, occurrence). `startsAt` and `endsAt` stay the first occurrence.
