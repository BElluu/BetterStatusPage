# Notification channels

Notification channels tell **your team** when a monitor goes down, degrades, recovers or has a TLS certificate about to expire. A channel is one destination — an email address, an HTTP endpoint, a Slack, Discord or Microsoft Teams webhook, a Telegram chat, an ntfy topic, a Pushover recipient — and you decide per monitor which channels it alerts.

Channels live under *Admin → Alerts → **Notifications*** (operator role or higher). To notify the people who read your status page instead, see [Subscriptions](subscriptions.md). To make something happen when a monitor goes down, such as starting a failover job, see [Actions](actions.md).

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
| **ntfy** | A topic on ntfy.sh or your own ntfy server | Push notification, high priority when a monitor is down |
| **Pushover** | A Pushover user or group | Push notification, high priority when a monitor is down |

Email and Webhook are fully templated. Slack, Discord, Teams and Telegram build a rich message automatically and let you add one templated line on top; ntfy and Pushover send a plain-text push the same way.

## Creating a channel

1. Go to **Notifications** and click **Add Channel** (or pick a type from the quick-start tiles while you have no channels yet).
2. Enter a **Name** and pick the **Type**. A technical [key](api.md#monitors-and-notification-channels-have-keys) is generated from the name; it is not shown in the form and never changes.
3. Fill in the type-specific fields (see below): where the messages go and the credentials.
4. Below them, the **Monitor** and **Action** tabs word the messages of the two kinds of event (see [Wording for monitors and for actions](#wording-for-monitors-and-for-actions)). **Notify on recovery (when monitor comes back up)** is on the Monitor tab and is off by default; **Notify when an action run succeeds** is its counterpart on the Action tab, also off by default (failed runs are always sent).
5. Set **Enabled**: a disabled channel sends nothing. On by default.
6. Optionally open the alert hygiene panel to set quiet hours, a rate cap or grouping — see [Alert hygiene](alert-hygiene.md).
7. Click **Create Channel**.

Deleting a channel also removes it from every monitor it was assigned to.

### Wording for monitors and for actions

One channel serves both. The **Monitor** tab words what is sent about monitors (status changes and certificates); the **Action** tab words what is sent about [actions](actions.md#when-a-run-fails), so you do not need a second channel to say something different about them. The Action tab has the same message fields as the Monitor tab, with the [action variables](#action-runs-only) available. A field you leave empty there is not filled from the Monitor tab: the message about an action is then sent in its default form (the standard message of the channel, and for a webhook a JSON with the action, the monitor, the status, the status that triggered it, the attempts, the error and the time). The destination, the credentials, quiet hours and limits are the channel's own, and recovery and grouping apply to monitors only.

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
| **Action** | A run of an [action](actions.md) failed after its last attempt, or succeeded when the channel is set to hear about successes, and the channel is one of the action's **Notifications** channels | Channel is **Enabled** (**Notify on recovery** does not matter) |
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

As long as you leave this template as it is, each message is worded for its event instead: "Monitor VM1 is DOWN", "TLS certificate of VM1 expires in 7 days", "Action Start VM2 failed for monitor VM1", each with the facts that belong to that event. Edit the subject or the body and the channel sends your template for every event about a monitor (status changes and certificates), with the variables listed below. Actions are worded on the **Action** tab of the channel, never by this template.

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

> In the **Body**, a variable is escaped so it stays valid inside a JSON string: a double quote or a line break in an error message, or the several lines of a grouped digest's `{{error_message}}`, do not break the JSON. Put variables inside string values (`"{{error_message}}"`). The receiver gets the escaped text and decodes it as it does any JSON string.

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

Each value is URL-encoded, so a monitor name with spaces or `&` stays one query value. In a header value, line breaks are removed.

---

## Slack, Discord, Microsoft Teams and Telegram

**Slack** posts a Block Kit card through an incoming webhook: a red, orange or green border by severity, the monitor name and status, fields for status, previous status, monitor type and error, and the check time. The optional **Message Text** is posted above the card and is where mentions such as `<!here>` go. See [Slack integration](slack-integration.md).

**Discord** posts a colour-coded embed with the same fields through a channel webhook. **Bot Username** overrides the webhook's display name, **Avatar URL** overrides its picture (a public image URL; Discord cannot take an uploaded file, and the BetterStatusPage logo is used when empty), and the optional **Message Content** is a plain-text line above the embed, used for `@here` or role mentions. See [Discord integration](discord-integration.md).

**Teams** posts a colour-coded MessageCard with the same facts. The optional **Summary** replaces the notification toast text. See [Microsoft Teams integration](teams-integration.md).

**Telegram** sends a formatted message through the Bot API with the same facts and a 🔴, 🟡 or 🟢 emoji by severity. It needs a **Bot Token** from @BotFather (shown masked once saved, or read from the [vault](vault.md)) and the **Chat ID** of the chat, group or channel (or `@channelusername`); the optional **Message Text** is a templated line above the message. The text is sent as HTML with every value escaped, and an oversized error message is cut to fit Telegram's 4096-character limit. See [Telegram integration](telegram-integration.md).

For certificate events all four switch the headline to *TLS certificate of … expires in N days* (or *… was renewed*) and label the detail field **Details** instead of **Error**.

---

## ntfy and Pushover

Both send a plain-text push notification: a headline (*Monitor API is DOWN*), then the status, previous status, monitor type, error and check time. A down monitor is sent with high priority, every other event with normal priority. The optional **Message Text** is a templated line above the facts. A message is cut to the service's limit (4000 bytes for ntfy, 1024 characters for Pushover).

**ntfy** publishes to a **Topic** on **Server URL** (`https://ntfy.sh` when empty; set your own server, with or without a path prefix). A topic is 1 to 64 letters, digits, `-` or `_`. Anyone who knows a topic on a public server can read it, so pick a hard-to-guess name or protect it with an **Access Token** (optional, shown only by its last four characters once saved, or read from the [vault](vault.md)). The Server URL cannot contain a login, query or fragment, and redirects are not followed. Changing it while keeping a stored access token is refused: enter the token again. The token is sent in a header, so use an `https://` server. A token read from the vault is not covered by that refusal.

**Pushover** needs an **Application Token** (create an application at pushover.net/apps/build; shown only by its last four characters once saved, or read from the [vault](vault.md)) and the **User Key** of the person or group that receives the messages. A vault secret for either token must be a **Secure Value** secret.

A failed send is recorded in the delivery history with the HTTP status and the service's own reason, for example `Pushover API returned HTTP 400: user identifier is invalid`. Tokens never appear in it.

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
| ntfy | **Message Text** |
| Pushover | **Message Text** |

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

### Action runs only

The `action` event carries the usual variables, with `{{status}}` set to `action-failed`, `action-approval` when a run is [waiting for approval](actions.md#actions-that-need-approval), or `action-succeeded` for a channel that is [set to hear about successes](actions.md#when-a-run-succeeds) (`{{error_message}}` is then empty for the last two), and `{{previous_status}}` to the status that triggered the action, and these:

| Variable | Value |
| --- | --- |
| `{{event_type}}` | `action` |
| `{{action_name}}` | Name of the action |
| `{{trigger_status}}` | `down` or `up`: the status the action was waiting for |
| `{{attempts}}` | How many attempts were made |
| `{{monitor_name}}` | The monitor the action ran for |
| `{{error_message}}` | The error of the last attempt, for example `HTTP 500: Job queue is full`. Never the request itself |

Slack, Discord, Teams and Telegram word it as "Action *Start VM2* failed for monitor *VM1*" and list the action, the monitor, the status it waited for and the attempts. A channel words it with what its **Action** tab says, with the variables above; a field left empty there gets the default form: the same wording as above for email, the standard message for the chat and push channels, and a JSON with the action, the monitor, the status, the status that triggered it, the attempts, the error and the time for a webhook. What you wrote on the **Monitor** tab is never used for an action. Quiet hours apply, a digest does not: a failed action is always sent on its own.

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

## Saved secrets

The webhook URL of a Slack, Discord or Microsoft Teams channel is the credential for posting to it, so a saved URL is
never shown again, in the form or in the API: it reads back as `••••••••`. The same goes for the Telegram bot token, the ntfy access token and the Pushover application token
(which keep their last four characters visible) and for credential headers of a webhook channel (a header whose name
contains `auth`, `token`, `secret`, `key`, `pass`, `pwd`, `credential`, `cookie`, `session` or `signature`). Leave the field untouched to keep
the stored value, or enter a new one to replace it. To change a webhook URL you paste the new one; there is nothing to edit. For a webhook channel, changing the **URL** while keeping a stored credential header is refused: enter the header again. Credentials written into a URL or the request body are not masked.

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

*Admin → Alerts → **Delivery history** → Notifications tab*

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

A channel has a unique `key` next to its `id` (see [Keys](api.md#monitors-and-notification-channels-have-keys)), `config` must be an object, and changing the `type` needs a new `config` in the same request. Secrets in `config` read back as `••••••••` (see [Saved secrets](#saved-secrets)): send that value back unchanged to keep the stored one. A channel's `config` depends on its type:

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
| `telegram` | `chatId`, and `botToken` or a `vault` reference to the token; `text` (optional) |
| `ntfy` | `topic`; `serverUrl`, `accessToken` or a `vault` reference to it, and `text` (all optional) |
| `pushover` | `userKey`, and `appToken` or a `vault` reference to the token; `text` (optional) |

Whether successful runs of an action are sent is `config.notifyOnActionSuccess` (`true`). The wording for actions is `config.eventOverrides.action`, made of the message fields of the type (`subject` and `body` for email, `body` for webhook, `content` for Discord, `summary` for Teams, `text` for the others). Any other field in it is refused, so it can never change where a message goes.

```json
"config": { "to": "ops@example.com", "subject": "Monitor {{monitor_name}} is {{status}}", "body": "…",
            "eventOverrides": { "action": { "subject": "Action {{action_name}}: {{status}}" } } }
```

Creating, updating and deleting channels, and changing SMTP settings, are written to the audit log.
