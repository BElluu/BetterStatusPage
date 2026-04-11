# Microsoft Teams Integration

Receive monitor alerts directly in a Microsoft Teams channel as formatted MessageCards — color-coded by severity, with all relevant details included automatically. No app installation or bot token required.

---

## How it works

When a monitor changes status (goes down, becomes degraded, or recovers), BetterStatusPage posts a **MessageCard** to your Teams channel via an **Incoming Webhook**. The card is color-coded:

- **Red card** — monitor is down
- **Orange card** — monitor is degraded
- **Green card** — monitor has recovered (only if "Notify on recovery" is enabled)

Each card includes the monitor name, current and previous status, monitor type, error message (if present), and the timestamp of the check.

---

## Important note on Microsoft's webhook deprecation

Microsoft is retiring **Office 365 Connectors** (the classic incoming webhook mechanism) and replacing them with **Power Automate Workflows**. The timeline has been extended several times, but you should be aware of which approach your tenant supports.

| Approach | Status | Webhook URL format |
|----------|--------|--------------------|
| Office 365 Connector (classic) | Being retired | `https://…webhook.office.com/webhookb2/…` |
| Power Automate Workflow | Recommended going forward | `https://prod-…logic.azure.com/…` or `https://…powerautomate.microsoft.com/…` |

**Both approaches work with BSP.** The MessageCard format used by BSP is accepted by both. The steps below cover both methods.

---

## Method A — Office 365 Connector (classic incoming webhook)

Use this if your tenant still supports Connectors, or if you already have a Connector webhook URL.

### Step 1 — Create an incoming webhook in Teams

1. Open the Teams channel where you want alerts delivered.
2. Click the **…** (More options) next to the channel name, then select **Manage channel**.

   > Alternatively, click the **+** (Add a tab) button at the top of the channel → search for **Incoming Webhook** → click **Add**.

3. In the channel settings, click **Edit** next to **Connectors**, then find **Incoming Webhook** and click **Configure**.
4. Give the webhook a name, e.g. `BSP Alerts`. Optionally upload a custom image.
5. Click **Create**.
6. Copy the webhook URL that appears — you will need this in BSP.
7. Click **Done**.

The URL looks like:

```
https://yourorg.webhook.office.com/webhookb2/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx@xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/IncomingWebhook/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

---

## Method B — Power Automate Workflow (recommended)

Use this if Connectors are disabled in your tenant, or if you want the modern approach.

### Step 1 — Create a workflow in Teams

1. Open the Teams channel where you want alerts delivered.
2. Click the **…** (More options) next to the channel name → select **Workflows**.
3. In the Workflows panel, search for **"Post to a channel when a webhook request is received"** and select it.
4. Click **Next**, give the workflow a name (e.g. `BSP Alerts`), then click **Create workflow**.
5. Copy the **webhook URL** shown at the end of the setup — this is your endpoint.
6. Click **Done**.

The URL looks like:

```
https://prod-xx.westeurope.logic.azure.com:443/workflows/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/triggers/manual/paths/invoke?api-version=2016-06-01&sp=…
```

> **Note:** Power Automate workflows accept a JSON body. The MessageCard format sent by BSP is compatible with the default "Post to a channel when a webhook request is received" template.

---

## Step 2 — Add a Teams notification channel in BSP

1. Log in to the **BetterStatusPage admin panel**.
2. Navigate to **Notifications** in the left sidebar.
3. Click **+ Add Channel**.
4. Fill in the form:

   | Field | Description |
   |-------|-------------|
   | **Name** | A label for this channel, e.g. `Teams #alerts` |
   | **Type** | Select **Teams** |
   | **Webhook URL** | Paste the URL copied from Teams or Power Automate |
   | **Summary** *(optional)* | The toast notification text shown by Teams before the card opens. Supports template variables. Leave blank to use the default: `Monitor <name> is DOWN` |

5. Toggle **Enabled** on.
6. Toggle **Notify on recovery** if you want a green card when the monitor comes back up.
7. Click **Create Channel**.

---

## Step 3 — Assign the channel to a monitor

A notification channel does nothing until it is linked to at least one monitor.

1. Go to **Monitors** and click the edit icon on the monitor you want.
2. In the monitor edit form, find the **Alerts** panel on the right.
3. Check the box next to the Teams channel you just created.
4. Click **Save**.

Repeat for any other monitors you want covered.

---

## Step 4 — Send a test notification

1. Go back to **Notifications**.
2. Click the edit icon on your Teams channel.
3. Click **Send Test** at the bottom of the form.
4. Check your Teams channel — a test card should appear within a few seconds.

If the card does not arrive, verify the webhook URL. A deleted or expired workflow will return HTTP 404 or 410, which BSP will log as a channel error.

---

## Summary field and template variables

The **Summary** field supports template variables. It controls the toast/banner text Teams shows before the user opens the card — useful for at-a-glance context in notifications.

| Variable | Example value |
|----------|--------------|
| `{{monitor_name}}` | `API Gateway` |
| `{{monitor_type}}` | `https` |
| `{{status}}` | `down` |
| `{{previous_status}}` | `up` |
| `{{error_message}}` | `connection timeout` |
| `{{checked_at}}` | `2026-04-11T03:14:15.000Z` |

Example:

```
🔴 {{monitor_name}} is {{status}} — {{error_message}}
```

---

## Troubleshooting

**Test card does not appear in Teams**
- Verify the webhook URL is correct and has not been deleted or disabled.
- Make sure the channel is **Enabled** in BSP.
- Ensure the Teams channel still exists and the webhook/workflow is still active.

**`HTTP 404` error in BSP logs**
- The Connector webhook or Power Automate workflow has been deleted. Re-create it and update the URL in BSP.

**`HTTP 410 Gone` error in BSP logs**
- Microsoft has retired the Office 365 Connector webhook for your tenant. Migrate to Power Automate (Method B above) and create a new workflow webhook.

**`HTTP 400` error in BSP logs**
- The payload was rejected. Ensure the URL is a valid Teams/Power Automate webhook endpoint and was not truncated when pasting.

**Cards arrive but look plain / formatting is missing**
- Make sure you are using the full webhook URL without modification. Both Connector and Workflow endpoints accept the MessageCard JSON format that BSP sends.

**I want alerts in multiple channels**
- Create one webhook per Teams channel, then create one BSP notification channel per webhook, and assign them to monitors as needed.
