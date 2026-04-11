# Discord Integration

Receive monitor alerts directly in a Discord channel as rich embeds — color-coded by severity, with all relevant details included automatically. No bot token, no OAuth, no bot invitation. Just a webhook URL.

---

## How it works

When a monitor changes status (goes down, becomes degraded, or recovers), BetterStatusPage posts a message to your Discord channel via a **Discord Incoming Webhook**. The message is a rich embed that looks like this:

- **Red embed** — monitor is down
- **Orange embed** — monitor is degraded
- **Green embed** — monitor has recovered (only if "Notify on recovery" is enabled)

Each embed includes:
- Monitor name and current status in the title
- Fields: Status, Previous status, Monitor type
- Error message (if present)
- Timestamp of the check

---

## Step 1 — Create a webhook in Discord

You need **Manage Webhooks** permission in the server (or be the server owner).

1. Open Discord and go to the **server** where you want alerts delivered.
2. Right-click the **channel** you want to use and select **Edit Channel**.

   > If you don't see this option, you don't have the required permissions. Ask your server admin.

3. In the channel settings, open the **Integrations** tab.
4. Click **Webhooks**, then **New Webhook**.
5. Give it a name (e.g. `BSP Alerts`) — this is the default display name in Discord. You can override it in BSP later.
6. Optionally upload an avatar image for the webhook.
7. Click **Copy Webhook URL** — you will need this URL in the next step.
8. Click **Save Changes**.

The URL looks like this:

```
https://discord.com/api/webhooks/1234567890123456789/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keep this URL private. Anyone who has it can post messages to your channel.

---

## Step 2 — Add a Discord notification channel in BSP

1. Log in to the **BetterStatusPage admin panel**.
2. Navigate to **Notifications** in the left sidebar.
3. Click **+ Add Channel**.
4. Fill in the form:

   | Field | Description |
   |-------|-------------|
   | **Name** | A label for this channel, e.g. `Discord #alerts` |
   | **Type** | Select **Discord** |
   | **Webhook URL** | Paste the URL copied from Discord |
   | **Bot Username** *(optional)* | Overrides the webhook's display name in Discord, e.g. `BSP Alerts` |
   | **Message Content** *(optional)* | Plain text posted above the embed — useful for pinging a role, e.g. `<@&ROLE_ID> monitor alert` |

5. Toggle **Enabled** on.
6. Toggle **Notify on recovery** if you want a green embed when the monitor comes back up.
7. Click **Create Channel**.

---

## Step 3 — Assign the channel to a monitor

A notification channel does nothing until it is linked to at least one monitor.

1. Go to **Monitors** and click the edit icon on the monitor you want.
2. In the monitor edit form, find the **Alerts** panel on the right.
3. Check the box next to the Discord channel you just created.
4. Click **Save**.

The channel is now active for that monitor. Repeat for any other monitors you want covered.

---

## Step 4 — Send a test notification

1. Go back to **Notifications**.
2. Click the edit icon on your Discord channel.
3. Click **Send Test** at the bottom of the form.
4. Check Discord — a test embed should appear within a few seconds.

If the test does not arrive, double-check the webhook URL. A deleted or disabled webhook in Discord will return HTTP 404, which BSP will log as a channel error.

---

## Message Content and template variables

The **Message Content** field (the optional plain-text line above the embed) supports template variables:

| Variable | Example value |
|----------|--------------|
| `{{monitor_name}}` | `API Gateway` |
| `{{monitor_type}}` | `https` |
| `{{status}}` | `down` |
| `{{previous_status}}` | `up` |
| `{{error_message}}` | `connection timeout` |
| `{{checked_at}}` | `2026-04-11T03:14:15.000Z` |

Example — ping a role when a monitor goes down:

```
<@&1234567890> {{monitor_name}} is {{status}}: {{error_message}}
```

To get a role ID in Discord: enable **Developer Mode** (User Settings → Advanced → Developer Mode), then right-click the role in Server Settings → Roles and select **Copy Role ID**.

---

## Pinging @here or @everyone

Discord webhooks can send `@here` and `@everyone` only if the webhook is granted that permission explicitly.

1. In Discord, go to **Server Settings → Integrations → Webhooks**.
2. Click your webhook and check whether **Allow @everyone and @here** is enabled.
3. If not, enable it (requires Manage Server permission).

Then set Message Content to `@here` or `@everyone` in the BSP channel form.

---

## Troubleshooting

**Test notification does not arrive**
- Verify the webhook URL is correct and has not been deleted in Discord.
- Make sure the channel is **Enabled** in BSP.
- Check that the target Discord channel still exists and the webhook is still linked to it.

**`HTTP 404` error in logs**
- The webhook was deleted in Discord. Create a new one and update the URL in BSP.

**`HTTP 400` error in logs**
- The webhook URL is malformed or the payload was rejected by Discord. Ensure the URL starts with `https://discord.com/api/webhooks/`.

**Notifications arrive but the role ping does not work**
- Check the **Allow @everyone and @here** permission on the webhook (see section above).
- Make sure the role ID in the Message Content field is correct.

**I want alerts in multiple channels**
- Create one Discord webhook per Discord channel, then create one BSP notification channel for each webhook, and assign them to monitors as needed.
