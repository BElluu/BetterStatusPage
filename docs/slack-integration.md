# Slack Integration

Receive monitor alerts directly in a Slack channel as rich Block Kit messages — color-coded by severity, with all relevant details included automatically. No bot token or Slack app required. Just an incoming webhook URL.

---

## How it works

When a monitor changes status (goes down, becomes degraded, or recovers), BetterStatusPage posts a message to your Slack channel via a **Slack Incoming Webhook**. The message is a Block Kit card with a colored left border:

- **Red border** — monitor is down
- **Orange border** — monitor is degraded
- **Green border** — monitor has recovered (only if "Notify on recovery" is enabled)

Each message includes the monitor name and current status in bold, fields for status / previous status / monitor type / error (when present), and a context line with the check timestamp.

---

## Step 1 — Create an incoming webhook in Slack

You need **Manage Apps** permission in the Slack workspace, or the ability to create apps. Workspace admins can restrict this — ask your admin if the steps below don't work.

### Via Slack App Directory (recommended)

1. Go to **[api.slack.com/apps](https://api.slack.com/apps)** and click **Create New App**.
2. Choose **From scratch**.
3. Give the app a name (e.g. `BSP Alerts`) and select your workspace. Click **Create App**.
4. In the left sidebar of the app settings, click **Incoming Webhooks**.
5. Toggle **Activate Incoming Webhooks** to **On**.
6. Click **Add New Webhook to Workspace** at the bottom of the page.
7. Select the channel you want alerts delivered to and click **Allow**.
8. Copy the **Webhook URL** that appears — it looks like:

   ```
   https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX
   ```

9. Keep this URL private. Anyone with it can post messages to that channel.

### Via Slack workflow builder (alternative)

Some workspaces disable third-party app installs but allow workflow webhooks:

1. In Slack, click **Automations** (rocket icon in the sidebar) or open any channel and click **+** → **Workflow Builder**.
2. Click **New Workflow** → **Start from scratch** → choose **Webhook** as the trigger.
3. Add a **Send a message** step pointing to the desired channel.
4. Publish the workflow and copy the webhook URL.

> Note: Workflow Builder webhooks accept a different payload format than Incoming Webhooks and may require extra configuration. The standard Incoming Webhook (via api.slack.com) is simpler and is what BSP targets.

---

## Step 2 — Add a Slack notification channel in BSP

1. Log in to the **BetterStatusPage admin panel**.
2. Navigate to **Notifications** in the left sidebar.
3. Click **+ Add Channel**.
4. Fill in the form:

   | Field | Description |
   |-------|-------------|
   | **Name** | A label for this channel, e.g. `Slack #alerts` |
   | **Type** | Select **Slack** |
   | **Webhook URL** | Paste the URL copied from Slack |
   | **Message Text** *(optional)* | Plain text prepended above the card — use for channel or user mentions. Supports template variables |

5. Toggle **Enabled** on.
6. Toggle **Notify on recovery** if you want a green card when the monitor comes back up.
7. Click **Create Channel**.

---

## Step 3 — Assign the channel to a monitor

A notification channel does nothing until it is linked to at least one monitor.

1. Go to **Monitors** and click the edit icon on the monitor you want.
2. In the monitor edit form, find the **Alerts** panel on the right.
3. Check the box next to the Slack channel you just created.
4. Click **Save**.

Repeat for any other monitors you want covered.

---

## Step 4 — Send a test notification

1. Go back to **Notifications**.
2. Click the edit icon on your Slack channel.
3. Click **Send Test** at the bottom of the form.
4. Check Slack — a test message should appear within a few seconds.

If the message does not arrive, verify the webhook URL. A deleted or revoked webhook will return `HTTP 403`, which BSP logs as a channel error.

---

## Message Text and template variables

The **Message Text** field is posted as a plain-text line above the Block Kit card. Its main use is for Slack mentions:

| Mention | Effect |
|---------|--------|
| `<!here>` | Notifies active members of the channel |
| `<!channel>` | Notifies all members of the channel |
| `<@U12345678>` | Notifies a specific user (use their Member ID) |
| `<!subteam^S12345678>` | Notifies a user group |

To find a user's Member ID: click their profile in Slack → **⋯** → **Copy member ID**.

Template variables also work in this field:

| Variable | Example value |
|----------|--------------|
| `{{monitor_name}}` | `API Gateway` |
| `{{monitor_type}}` | `https` |
| `{{status}}` | `down` |
| `{{previous_status}}` | `up` |
| `{{error_message}}` | `connection timeout` |
| `{{checked_at}}` | `2026-04-11T03:14:15.000Z` |

Example — ping the on-call user group for any alert:

```
<!subteam^S12345678> {{monitor_name}} is {{status}}
```

---

## Troubleshooting

**Test message does not appear in Slack**
- Verify the webhook URL is correct and has not been deleted or revoked.
- Make sure the channel is **Enabled** in BSP.
- Check that the webhook's Slack app is still installed in the workspace (Settings → Manage Apps).

**`HTTP 403` error in BSP logs**
- The webhook token has been revoked. Regenerate it in api.slack.com → your app → Incoming Webhooks, then update the URL in BSP.

**`HTTP 404` error in BSP logs**
- The webhook URL path is malformed or the app was deleted. Create a new webhook and update BSP.

**`no_service` or `channel_not_found` error body**
- The channel the webhook was pointing to was deleted or the app was removed from it. Recreate the webhook pointing to an active channel.

**Mentions like `<!here>` are not working**
- Make sure the Message Text field contains exactly `<!here>` (with the angle brackets) — not `@here`.
- The Slack app may need **Post to channels** permission. Check the app's OAuth scopes at api.slack.com.

**I want alerts in multiple Slack channels**
- Create one incoming webhook per channel, then create one BSP notification channel per webhook, and assign them to monitors as needed.
