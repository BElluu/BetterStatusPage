# Notification channels

Notification channels tell **your team** when a monitor goes down, degrades, recovers or has a TLS certificate about to expire. A channel is one destination — an email address, an HTTP endpoint, a Slack, Discord or Microsoft Teams webhook, a Telegram chat — and you decide per monitor which channels it alerts.

Channels live under *Admin → Configure → **Notifications*** (operator role or higher). To notify the people who read your status page instead, see [Subscriptions](subscriptions.md).

---

## Channel types

| Type | Sends to | Message format |
| --- | --- | --- |
| **Email** | One or more addresses, through the instance-wide SMTP server | Plain text, your own subject and body |
| **Webhook** | Any HTTP endpoint | Your own method, headers and body |
| **Slack** | A Slack incoming webhook | Colour-coded Block Kit card |
| **Discord** | A Discord channel webhook | Colour-coded embed |
| **Teams** | A Microsoft Teams webhook | Colour-coded MessageCard |
| **Telegram** | A Telegram chat, group or channel, through your own bot | Formatted message with a severity emoji |

Email and Webhook are fully templated. Slack, Discord, Teams and Telegram build a rich message automatically and let you add one templated line on top.

## Creating a channel

1. Go to **Notifications** and click **Add Channel** (or pick a type from the quick-start tiles while you have no channels yet).
2. Enter a **Name** and pick the **Type**.
3. Fill in the type-specific fields (see below).
4. Set the two switches:
   - **Enabled** — a disabled channel sends nothing. On by default.
   - **Notify on recovery (when monitor comes back up)** — off by default.
5. Optionally open the alert hygiene panel to set quiet hours, a rate cap or grouping — see [Alert hygiene](alert-hygiene.md).
6. Click **Create Channel**.

Deleting a channel also removes it from every monitor it was assigned to.

## Assigning channels to monitors

A channel does nothing until it is linked to at least one monitor. Open *Monitors → edit a monitor*, open the **Alerts** panel and tick the channels that monitor should notify, then **Save**. A monitor can use any number of channels, and a channel can serve any number of monitors. See [Monitors](monitors.md) for the rest of the form.

The usual pattern is a few channels with different rules — an on-call channel without quiet hours for critical monitors, and a quieter one for everything else.

## Which events a channel sends

| Event | When it fires | Sent when |
| --- | --- | --- |
| **Alert** | A monitor is confirmed `down` or `degraded` (after its failure threshold) | Channel is **Enabled** |
| **Recovery** | A monitor that had alerted is confirmed `up` again | Channel is **Enabled** and **Notify on recovery** is on |
| **Certificate** — expiring | An HTTPS monitor's certificate reaches a warning milestone | Channel is **Enabled** |
| **Certificate** — renewed | A certificate you were warned about has been replaced | Channel is **Enabled** and **Notify on recovery** is on |
| **Test** | You click **Send test** | Channel is **Enabled** |

There are no other per-event switches. A monitor in the `affected` state (one of its dependencies is already down) does not alert, so the root cause sends the only alert. Certificate warnings are switched on per HTTPS monitor, with a lead time of 14 days by default and reminders 7, 3 and 1 days before expiry — see [Monitors](monitors.md).

Every event then passes through the channel's alert hygiene rules (quiet hours, rate cap, grouping) before it is sent. Test notifications skip those rules.

---

## Email

Email channels send through one SMTP server configured for the whole instance. Each channel only holds the recipients and the message templates.

### SMTP settings

*Admin → Notifications → **SMTP Settings***

The same SMTP server is used by every email channel and by email [subscriptions](subscriptions.md).

| Field | Description |
| --- | --- |
| **Host** | SMTP server, e.g. `smtp.example.com`. Email channels fail with `SMTP not configured` while this is empty |
| **Port** | Default `587` |
| **Use TLS/SSL (port 465)** | On: TLS from the first byte (port 465). Off: plain connection that is upgraded with STARTTLS when the server offers it (ports 587 and 25) |
| **Credentials** | **Direct input** (username and password) or **From Vault** |
| **From Address** | Sender address, e.g. `alerts@example.com` |
| **From Name** | Sender display name. Default `BSP Alerts` |

Messages are sent as `"From Name" <From Address>`. Fill in both — without a From Address only the name is used as the sender, which most servers reject. Leave the username empty for a relay that does not require authentication.

The stored password is never shown again. When you change the host, port or username you must re-enter the password, so a saved password can never be sent to a different server or account.

**Send Test Email** sends a short test message to the address you enter. It uses the **saved** settings, so click **Save Settings** first.

### SMTP credentials from the vault

Choose **From Vault** to keep the SMTP username and password in the encrypted [vault](vault.md) instead of the settings table. Pick the **Vault** and the **Secret**:

| Secret type | How it maps |
| --- | --- |
| `userpass` | `username` → SMTP user, `password` → SMTP password, automatically |
| `json` | Fill in **JSON Field Mapping** with the JSON keys that hold the `username` and `password`. Without a mapping, keys named `username` (or `user`) and `password` are used |

Use one of these two types. A `value` secret carries no username, so the connection is made without authentication. When vault credentials are selected, any directly entered username and password are cleared.

### Email channel fields

| Field | Description |
| --- | --- |
| **To** | Recipient address. Separate several addresses with commas. Supports template variables |
| **Subject** | Supports template variables |
| **Body** | Plain-text body. Supports template variables |

New channels start with this template:

```
Subject: Monitor {{monitor_name}} is {{status}}

Monitor: {{monitor_name}}
Type:    {{monitor_type}}
Status:  {{status}}
Error:   {{error_message}}
Time:    {{checked_at}}
```

Channel emails are plain text only. The branded HTML layout that follows your status page colours and logo is used for subscriber emails, not for notification channels.

---

## Webhook

A generic webhook sends one HTTP request per notification to any endpoint — an incident management tool, a chat bot, an automation platform, your own service.

| Field | Description |
| --- | --- |
| **URL** | Endpoint to call. Supports template variables |
| **Method** | `GET`, `POST` (default), `PUT` or `PATCH` |
| **Headers** | Any number of name/value pairs. Values support template variables, names do not |
| **Body** | Request body template. Hidden for `GET`, which sends no body |

Every request carries `Content-Type: application/json` unless you add your own `Content-Type` header. A request that does not answer within **15 seconds**, or answers with anything other than a `2xx` status, counts as a failed attempt (error `HTTP 500`, for example) and is retried — see [Retries](#retries).

### Payload

There is no fixed payload: the body is exactly your template with the variables filled in. New webhook channels start with:

```json
{
  "monitor": "{{monitor_name}}",
  "status": "{{status}}",
  "error": "{{error_message}}",
  "time": "{{checked_at}}"
}
```

which is sent as, for example:

```json
{
  "monitor": "Checkout API",
  "status": "down",
  "error": "connection timeout",
  "time": "2026-04-11T03:14:15.000Z"
}
```

> Variables are inserted as-is — they are **not** JSON-escaped. An error message containing a double quote or a line break, or a grouped digest (whose `{{error_message}}` has one line per monitor), can produce invalid JSON. If your endpoint is strict, leave `{{error_message}}` out of JSON bodies or make sure the receiver tolerates it.

### Examples

**An incident management endpoint with a bearer token**

- **Method**: `POST`
- **URL**: `https://incidents.example.com/api/v1/events`
- **Headers**: `Authorization` = `Bearer 0123456789abcdef`

```json
{
  "source": "betterstatuspage",
  "event": "{{event_type}}",
  "summary": "{{monitor_name}} is {{status}}",
  "severity": "{{status}}",
  "previous": "{{previous_status}}",
  "occurred_at": "{{checked_at}}"
}
```

Use `{{event_type}}` (`alert`, `recovery`, `certificate`, `test`) to let the receiver open and close incidents.

**A GET-only endpoint**

Put the data in the URL instead of a body:

```
https://hooks.example.com/notify?monitor={{monitor_name}}&status={{status}}
```

Values are not URL-encoded, so this works best with monitor names that contain no spaces or special characters.

---

## Slack, Discord, Microsoft Teams and Telegram

**Slack** posts a Block Kit card through an incoming webhook: a red, orange or green border by severity, the monitor name and status, fields for status, previous status, monitor type and error, and the check time. The optional **Message Text** is posted above the card and is where mentions such as `<!here>` go. See [Slack integration](slack-integration.md).

**Discord** posts a colour-coded embed with the same fields through a channel webhook. **Bot Username** overrides the webhook's display name, **Avatar URL** overrides its picture (a public image URL; Discord cannot take an uploaded file, and the BetterStatusPage logo is used when empty), and the optional **Message Content** is a plain-text line above the embed, used for `@here` or role mentions. See [Discord integration](discord-integration.md).

**Teams** posts a colour-coded MessageCard with the same facts. The optional **Summary** replaces the notification toast text. See [Microsoft Teams integration](teams-integration.md).

> [!WARNING]
> **Not released yet.** Telegram is only in the `main` branch; build the image yourself from the `main` branch (see [Deployment](deployment.md)).

**Telegram** sends a formatted message through the Bot API with the same facts and a 🔴, 🟡 or 🟢 emoji by severity. It needs a **Bot Token** from @BotFather and the **Chat ID** of the chat, group or channel (or `@channelusername`); the optional **Message Text** is a templated line above the message. The text is sent as HTML with every value escaped, and an oversized error message is cut to fit Telegram's 4096-character limit. See [Telegram integration](telegram-integration.md).

For certificate events all four switch the headline to *TLS certificate of … expires in N days* (or *… was renewed*) and label the detail field **Details** instead of **Error**.

---

## Template variables

Any `{{name}}` in a templated field is replaced when the notification is sent. Templated fields are:

| Channel | Fields |
| --- | --- |
| Email | **To**, **Subject**, **Body** |
| Webhook | **URL**, header values, **Body** |
| Slack | **Message Text** |
| Discord | **Message Content** |
| Teams | **Summary** |
| Telegram | **Message Text** |

A variable that does not exist for the event is left in the text unchanged — for example `{{cert_host}}` in an ordinary alert is sent literally as `{{cert_host}}`.

### All events

| Variable | Meaning | Example |
| --- | --- | --- |
| `{{monitor_name}}` | Monitor name; `N monitors` in a digest | `Checkout API` |
| `{{monitor_type}}` | `https`, `ping`, `dns`, `sqlserver`, `postgresql`, `mysql`, `mongodb`, `docker`, `webhook`; `group` in a digest | `https` |
| `{{status}}` | New status: `down`, `degraded`, `up`, `cert-expiring`, `cert-renewed`; the worst status in a digest | `down` |
| `{{previous_status}}` | Status before the change; `various` in a digest whose members differ | `up` |
| `{{error_message}}` | Error of the failing check, empty on recovery; a certificate sentence for certificate events; one line per monitor in a digest | `connection timeout` |
| `{{checked_at}}` | When the event was raised (ISO 8601, UTC). For a digest, when the digest was built | `2026-04-11T03:14:15.000Z` |
| `{{event_type}}` | `alert`, `recovery`, `certificate` or `test` | `alert` |
| `{{monitor_list}}` | Comma-separated monitor names in a digest; the monitor's own name otherwise | `Checkout API, Search API` |
| `{{affected_count}}` | Number of monitors in a digest; `1` otherwise | `1` |

### Certificate events only

| Variable | Meaning | Example |
| --- | --- | --- |
| `{{cert_host}}` | Host the certificate was read from | `shop.example.com` |
| `{{cert_expires_at}}` | Expiry date (ISO 8601, UTC) | `2026-05-01T12:00:00.000Z` |
| `{{cert_expires_in}}` | Time left in words, rounded down | `in 7 days`, `in less than a day` |
| `{{cert_days_left}}` | Whole days left | `7` |

For certificate events `{{status}}` is `cert-expiring` or `cert-renewed`, `{{previous_status}}` is the monitor's current status, and `{{error_message}}` reads, for example, `TLS certificate for shop.example.com expires in 7 days (2026-05-01T12:00:00.000Z)`.

Digests are described in [Alert hygiene](alert-hygiene.md#grouping-bursts-into-one-digest).

---

## Sending a test notification

Open an existing channel with the edit icon and click **Send test (saved settings)**. The button is only shown for saved channels and is disabled while the form has unsaved changes — save first, because the test uses the stored configuration.

The test goes out immediately, ignoring quiet hours, the rate cap and grouping, with these values:

| Variable | Test value |
| --- | --- |
| `{{monitor_name}}` | `Test Monitor` |
| `{{monitor_type}}` | `https` |
| `{{status}}` | `down` |
| `{{previous_status}}` | `up` |
| `{{error_message}}` | `This is a test notification` |
| `{{event_type}}` | `test` |
| `{{monitor_list}}` / `{{affected_count}}` | `Test Monitor` / `1` |

The form shows *Test sent successfully* or the error returned by the destination. A disabled channel fails the test with *Notification channel is disabled*. Every test is recorded in the delivery history; a failed test is retried like any other delivery.

To check only the SMTP connection, use **Send Test Email** in **SMTP Settings** instead — it does not need a channel and is not recorded in the history.

---

## Delivery history

*Admin → Monitoring → **Delivery history** → Notifications tab*

Every notification — sent, failed, waiting or suppressed — is listed with the monitor and its status change, the channel, the event, the number of attempts and the delivery status. Filter by status, channel and event; click a row to see each attempt with its time and error. The list refreshes every 30 seconds, and entries older than 180 days are deleted automatically.

| Status | Meaning |
| --- | --- |
| **Pending** | Queued, waiting for its next retry, or held by quiet hours or a digest window (*Held until …*) |
| **Delivered** | The destination accepted it |
| **Failed** | Every attempt failed; the last error is shown |
| **Suppressed** | Alert hygiene stopped it, with the reason (quiet hours, rate cap, merged into digest) |

How to read suppressed and held entries is covered in [Alert hygiene](alert-hygiene.md#reading-the-delivery-history).

### Retries

Each notification gets **3 attempts**:

| Attempt | When |
| --- | --- |
| 1 | Immediately (or when quiet hours or a digest window release it) |
| 2 | About 1 minute after the first failure |
| 3 | About 5 minutes after the second failure |

A background worker picks up due retries every 30 seconds, so each wait can be up to 30 seconds longer. After the third failure the delivery is **Failed**. A channel that has been disabled or deleted in the meantime fails its pending deliveries with *Notification channel is disabled* or *Notification channel no longer exists*.

For a **Failed** delivery, expand the row and click **Retry now**. That sends it immediately with the variables of the original event and, if it fails again, allows three more attempts on the same schedule. Manual retries are written to the audit log.

---

## Maintenance windows

Monitors inside an active maintenance window do not send alerts or recoveries — status changes are still tracked, and an outage that is still going when the window ends alerts then. Certificate expiry warnings are not affected by maintenance. See [Incidents and maintenance](incidents-and-maintenance.md).

---

## API

Channels and history are available under `/api/v1/admin/notifications`:

| Method and path | Purpose |
| --- | --- |
| `GET /channels`, `POST /channels` | List or create channels |
| `GET`, `PATCH`, `DELETE /channels/:id` | Read, update or delete a channel |
| `POST /channels/:id/test` | Send a test notification |
| `GET`, `PUT /monitor/:monitorId/channels` | Read or replace a monitor's channels (`{ "channelIds": [1, 2] }`) |
| `GET /deliveries` | Delivery history; filters `status`, `channelId`, `channelType`, `monitorId`, `eventType`, `from`, `to` |
| `GET /deliveries/:id` | One delivery with its attempts |
| `POST /deliveries/:id/retry` | Retry a failed delivery |
| `GET`, `PUT /smtp`, `POST /smtp/test` | SMTP settings and test email |

A channel's `config` depends on its type:

```json
{ "name": "On-call webhook", "type": "webhook", "enabled": 1, "notifyOnRecovery": 1,
  "config": { "url": "https://incidents.example.com/api/v1/events", "method": "POST",
              "headers": { "Authorization": "Bearer 0123456789abcdef" },
              "body": "{\"summary\": \"{{monitor_name}} is {{status}}\"}" } }
```

| Type | `config` fields |
| --- | --- |
| `email` | `to`, `subject`, `body` |
| `webhook` | `url`, `method`, `headers` (optional), `body` (optional) |
| `slack` | `webhookUrl`, `text` (optional) |
| `discord` | `webhookUrl`, `username`, `avatarUrl`, `content` (all but `webhookUrl` optional) |
| `teams` | `webhookUrl`, `summary` (optional) |

Creating, updating and deleting channels, and changing SMTP settings, are written to the audit log.
