# Status page subscriptions

Notification channels (`Notifications` in the admin console) alert **your team** when a monitor changes status. Subscriptions are the other direction: they let **the people who read your status page** follow what you publish — by email, by webhook, in a Slack channel, through an RSS/Atom feed, or by polling a JSON API.

Subscribers only ever hear about things an operator publishes: incidents, incident updates, resolutions and scheduled maintenance. Monitor flaps never reach them.

## Turning it on

Open **Configure → Subscribers** in the admin console (operator role or higher).

1. Switch on **Allow visitors to subscribe** — the master switch for everything below.
2. Switch on the **subscription methods** you want to offer. Each method card shows whether visitors will actually be offered it and, if not, what is missing.
3. For email and webhook, configure SMTP (**Notifications → SMTP Settings**) and set `PUBLIC_URL` in the server environment (for example `PUBLIC_URL=https://status.example.com` in `.env`), then restart. Both methods confirm subscribers by email, and every email links back to the page.
4. Save. The status page picks up the change on its next load.

Visitors click **Subscribe** on the status page, pick one of the offered methods, and only then see its form or instructions. When no method is available the button is hidden.

## Public URL

Every link given to subscribers — confirmation and manage links in emails and webhook payloads, the Slack command, the feed and API addresses — is built from the `PUBLIC_URL` environment variable. It is deliberately not an admin setting: whoever controls it decides where confirmation links point, so changing it requires access to the server rather than an operator account. The admin console shows the value read-only.

Without `PUBLIC_URL`, email and webhook are not offered (an email needs an absolute link). Slack, feeds and the API still work and use the address the visitor opened the page on. A value that is not an absolute `http(s)` URL is ignored with a warning in the server log.

## Subscription methods

| Method | What the visitor does | Needs |
|---|---|---|
| Email | Enters an address and confirms it by email | SMTP, `PUBLIC_URL`, at least one notification type |
| Webhook | Registers an https URL (optionally method and headers) and confirms by email | SMTP, `PUBLIC_URL`, at least one notification type |
| Slack | Pastes a `/feed subscribe` command into a Slack channel | at least one notification type |
| RSS / Atom | Adds a feed to a feed reader | — |
| Status API | Polls `summary.json` / `components.json` | — |

Every method also needs the master switch. With the master switch off, the Subscribe button is hidden, the feeds and the status API answer `404`, and existing subscribers receive nothing (they are kept). Switching email or webhook off also stops deliveries to existing subscribers of that type.

## What subscribers can receive

| Setting | Effect |
|---|---|
| Notifications subscribers may receive | The event types offered to email, webhook and Slack: new incidents, incident updates, resolutions, scheduled maintenance. Subscribers choose from this list; anything you remove stops being sent. |
| Let subscribers choose components | Email and webhook subscribers can follow selected monitors or tags instead of everything. Only monitors placed on the public page (in the Page Builder) are offered, so internal monitor names never leak. |

Each time you create an incident, post an update or schedule maintenance, a **Notify subscribers** checkbox (on by default) lets you publish quietly — useful for typo fixes or internal notes.

### Who receives what

- A subscriber receives an event only if its type is both allowed by you and chosen by them.
- A subscriber scoped to components receives an incident if any linked monitor is one they follow, or carries a tag they follow.
- An incident or maintenance window with **no linked monitors** is treated as page-wide and goes to every subscriber who chose that event type.
- An update posted with status *resolved* is sent as a **resolution**, not an update. A subscriber who only wants resolutions still gets it.

## The subscriber side

1. The visitor fills in the form. A hidden honeypot field, a 5-per-15-minutes limit per IP, and a 10-minute per-destination cooldown on confirmations keep the form from being used to spam people.
2. A confirmation link (valid 48 hours) goes to the email address they entered. Nothing is sent until they click **Confirm subscription** on the page — a plain link visit is not enough, so mail scanners that prefetch links cannot confirm on someone's behalf.
3. Every notification carries one **Manage or unsubscribe** link — the page behind it changes event types or components, unsubscribes, and subscribes again — plus a standard `List-Unsubscribe` header with RFC 8058 one-click support, so Gmail's and Outlook's own unsubscribe buttons work.

### What the emails look like

Subscriber emails are HTML with a plain-text alternative, branded from **Branding**: the uploaded logo (the light variant, shown 40 px high) or the text logo, the site name, and the page colours when custom branding is on. Without an uploaded logo the site name is set as text. Incident emails show the status as a coloured badge in the same colours as on the status page, the impact, affected components and the posted update; the button uses the same colours as the status page and admin buttons. Logos load from `PUBLIC_URL`, so they only appear once the page is reachable at that address.

The layout lives in `apps/api/src/services/emailTemplate.ts`: every message is data (title, details, quote, button, footer) poured into one `renderEmail` layout, so an editable template can replace it later without touching the code that sends the mail.

The form answers the same way whether the address is new, pending or already subscribed. An already-subscribed address receives a reminder with its manage link instead, so nobody can change someone else's preferences.

Tokens in links sit in the URL fragment (`/#subscription=…`), which browsers never send to the server. The one-click unsubscribe URL has to carry its token in the query string, and the API redacts `token=` from request logs.

## Webhook subscribers

Webhooks are off by default. When on, the form asks for:

- **Webhook URL** — an `https` address that receives a JSON request for every event the subscriber chooses.
- **Email address** — the confirmation link goes here, and so do failure alerts.
- **Email me if my URL stops responding** — opt-in failure alerts (checked by default).
- **Customize request** (optional) — the HTTP method (`POST`, `PUT` or `PATCH`) and up to 10 custom headers, for example `Authorization: Bearer …` so the receiver can authenticate the calls.

Header values usually hold credentials. They are stored encrypted with `VAULT_ENCRYPTION_KEY` and never leave the server again: the admin console and the manage page show header names only, and on the manage page a header left with an empty value keeps its saved value. Transport headers (`Host`, `Content-Type`, `Content-Length`, `Connection`, `User-Agent`, `Cookie`, …) and anything starting with `X-BSP-` cannot be overridden.

### When the endpoint fails

A delivery that still fails after all its retries (1, 5 and 30 minutes) counts as one failure:

- If the subscriber opted in, they get an email with the error and a link to fix their settings — at most once a day.
- After **5 failed deliveries in a row** the subscription is **paused**, and the subscriber is emailed a notice with a link to turn it back on. This notice goes out even without the opt-in, so nobody is switched off silently.
- Any successful delivery resets the count. A paused subscription shows as *Paused* in the admin console; its owner resumes it from the manage page.

Pausing also limits what happens when someone registers a URL that is not theirs: a target that rejects the requests stops receiving them after five events. A target that happily answers `2xx` to anything keeps receiving them until the subscriber unsubscribes — confirmation proves control of the email address, not of the URL.

### Event payload

Each event is sent with the chosen method, `Content-Type: application/json`, an `X-BSP-Event` header and the subscriber's custom headers. Timestamps are ISO 8601:

```json
{
  "event": "incident.updated",
  "occurredAt": "2026-09-24T10:15:00.000Z",
  "meta": {
    "manageUrl": "https://status.example.com/#subscription=manage&token=…"
  },
  "page": { "name": "Acme Status", "url": "https://status.example.com/" },
  "incident": {
    "id": 12,
    "title": "Checkout errors",
    "status": "identified",
    "impact": "major",
    "startedAt": "2026-09-24T09:58:00.000Z",
    "resolvedAt": null,
    "url": "https://status.example.com/",
    "updates": [
      { "body": "Rolling back the last deploy.", "status": "identified", "postedAt": "2026-09-24T10:15:00.000Z" }
    ]
  },
  "update": { "body": "Rolling back the last deploy.", "status": "identified", "postedAt": "2026-09-24T10:15:00.000Z" },
  "components": [{ "id": 3, "name": "Checkout API" }]
}
```

- `event` is one of `incident.created`, `incident.updated`, `incident.resolved`, `maintenance.scheduled`.
- `incident.updates` holds every update so far, newest first; `update` is the one that triggered this event (absent for `incident.created`).
- Maintenance events carry `maintenance: { id, name, description, startsAt, endsAt, url }` instead of `incident`.
- `components` lists only components shown on the public page; it is empty for page-wide events.

### Network safety

Because anonymous visitors choose these URLs, the server refuses to call loopback, private, link-local, carrier-grade NAT and other reserved addresses. The check runs when the connection is opened, so DNS rebinding between signup and delivery does not get around it, and redirects are never followed. If your status page runs inside an intranet and must notify internal systems, set `SUBSCRIBER_WEBHOOK_ALLOW_PRIVATE=true`. Plain `http` URLs are then allowed too.

## Slack

Slack needs no signup on your side. The subscribe dialog shows a command such as:

```
/feed subscribe https://status.example.com/api/v1/public/slack.rss
```

Anyone pastes it into the Slack channel of their choice, and Slack's built-in RSS app posts every new item from then on. Nothing is stored about these subscribers, so they do not appear in the subscriber list; they leave with `/feed list` and `/feed remove` in Slack.

The Slack feed is an **event stream**: one item per new incident, per update, per resolution and per scheduled maintenance, filtered by the event types you allow. The regular `incidents.rss` has one item per incident that changes over time, which would make Slack repost an incident's whole history on every update.

Keep in mind:

- Slack polls the feed on its own schedule, so posts can lag behind the status page by several minutes. Email and webhooks are immediate.
- Slack fetches the feed from its own servers, so the status page must be reachable from the internet. An intranet-only page cannot use it.
- Slack cannot be scoped to components, and the *Notify subscribers* checkbox does not apply to it: like the other feeds, it mirrors what is public on the page.
- The feed answers 404 when the master switch or Slack is off, or no event types are allowed.

## Delivery and retention

- Deliveries are queued and sent in the background, five at a time. Failed ones are retried after 1, 5 and 30 minutes; the last error shows on the subscriber's row in the admin console.
- Delivery records are deleted after 90 days. Subscriptions never confirmed are deleted a week after their link expires.
- Unsubscribed people stay in the list, marked *Unsubscribed*, so they can re-subscribe from their manage link. Delete a row in the admin console to erase the address entirely.
- Webhook health (failure alerts and pausing) is described under [When the endpoint fails](#when-the-endpoint-fails).

## Feeds

```
GET /api/v1/public/incidents.rss
GET /api/v1/public/incidents.atom
GET /api/v1/public/slack.rss      # per-event stream for Slack, see above
```

Both list the 50 most recently updated incidents with their full update history. They are cached for 60 seconds and rate-limited to 60 requests per minute per client. The status page advertises the RSS feed with `<link rel="alternate">` so feed readers find it automatically.

## Status API

A read-only JSON API for other teams' dashboards, scripts and monitoring. It needs no key, allows cross-origin browser requests (`Access-Control-Allow-Origin: *`), is cached for 30 seconds and rate-limited to 120 requests per minute per client. The subscribe dialog lists both endpoints on its **API** tab.

Only components placed on the public page appear, with the status visitors see: an active *minor* incident marks its components as degraded, a *major* or *critical* one as down, and a running maintenance window as under maintenance.

### ```GET /api/v1/public/summary.json```

Overall page status, unresolved incidents, and maintenance windows that are running or scheduled.

```json
{
  "page": { "name": "Acme Status", "url": "https://status.example.com/", "status": "has_issues" },
  "activeIncidents": [
    {
      "id": 12,
      "name": "Checkout errors",
      "status": "identified",
      "impact": "major",
      "startedAt": "2026-09-24T09:58:00.000Z",
      "updatedAt": "2026-09-24T10:15:00.000Z",
      "url": "https://status.example.com/",
      "components": [{ "id": 3, "name": "Checkout API" }]
    }
  ],
  "activeMaintenances": [
    {
      "id": 4,
      "name": "Database upgrade",
      "description": null,
      "status": "not_started",
      "startsAt": "2026-09-26T01:00:00.000Z",
      "endsAt": "2026-09-26T03:00:00.000Z",
      "duration": 120,
      "url": "https://status.example.com/",
      "components": []
    }
  ]
}
```

- `page.status`: `operational`, `has_issues` (an unresolved incident or any component not operational), or `under_maintenance` (a window is running and nothing else is wrong).
- Maintenance `status`: `in_progress` or `not_started`; `duration` is in minutes; empty `components` means the whole page.

### ```GET /api/v1/public/components.json```

The components on the public page, grouped as they are there.

```json
{
  "components": [
    { "id": 1, "name": "API", "status": "degraded_performance", "description": null, "isParent": false, "children": [] },
    {
      "id": "group:core",
      "name": "Core",
      "status": "partial_outage",
      "description": null,
      "isParent": true,
      "children": [
        { "id": 2, "name": "Web", "status": "operational", "description": null, "isParent": false, "children": [] },
        { "id": 3, "name": "Search", "status": "major_outage", "description": null, "isParent": false, "children": [] }
      ]
    }
  ]
}
```

- Component `status`: `operational`, `degraded_performance`, `partial_outage`, `major_outage`, `under_maintenance`.
- A component's `id` is the same number used in webhook payloads and subscription scopes. Groups have string ids (`group:<layout id>`). A group is `partial_outage` when some children are down, `major_outage` when all are.

## API reference

Public (`/api/v1/public/subscriptions`):

| Method | Path | Body |
|---|---|---|
| GET | `/options` | — |
| POST | `/` | `{ type, email, webhookUrl?, webhookMethod?, webhookHeaders?, notifyOnFailure?, events?, monitorIds?, tags? }` → `202` |
| POST | `/confirm` | `{ token }` |
| POST | `/preferences` | `{ token }` — read preferences |
| PUT | `/preferences` | `{ token, events, monitorIds?, tags?, webhookMethod?, webhookHeaders?, notifyOnFailure?, resubscribe? }` — `resubscribe` also resumes a paused webhook |
| POST | `/unsubscribe` | `{ token }`, or `?token=` with a form body for one-click |

Admin (`/api/v1/admin/subscribers`, operator role or higher): `GET/PUT /settings`, `GET /?status=&search=&page=&limit=`, `DELETE /:id`. Changes to settings and deletions are recorded in the audit log.
