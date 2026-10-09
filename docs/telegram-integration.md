# Telegram Integration

> [!WARNING]
> **Not released yet.** This feature is only in the `main` branch; build the image yourself from the `main` branch (see [Deployment](deployment.md)).

Receive monitor alerts in a Telegram chat, group or channel as formatted messages with a severity emoji and all relevant details included automatically. You need a bot token and the ID of the chat that should receive the alerts.

---

## How it works

When a monitor changes status (goes down, becomes degraded, or recovers), BetterStatusPage sends a message through your Telegram bot using the Bot API (`sendMessage`). The message starts with a severity emoji:

- 🔴 monitor is down
- 🟡 monitor is degraded
- 🟢 monitor has recovered (only if "Notify on recovery" is enabled)

Each message includes the monitor name and current status in bold, the status, previous status, monitor type and error (when present), and the check time.

---

## Step 1 — Create a bot

1. In Telegram, open a chat with **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` and answer the two questions (display name and a username ending in `bot`).
3. Copy the **token** BotFather returns — it looks like:

   ```
   123456789:AAExampleTokenExampleTokenExample
   ```

4. Keep the token private. Anyone with it can control the bot.

---

## Step 2 — Find the chat ID

The bot can only write to a chat it has been added to.

- **Private chat with you:** open the bot and press **Start** (or send it any message).
- **Group:** add the bot to the group.
- **Channel:** add the bot as an administrator with permission to post messages.

Then get the chat ID:

- A **public channel** can use its username as the ID, for example `@my_alerts`.
- For anything else, open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser after sending a message to the bot (or in the group) and read `chat.id` from the response. Group IDs are negative, and supergroups and channels start with `-100`, for example `-1001234567890`.

---

## Step 3 — Add a Telegram notification channel in BSP

1. Log in to the **BetterStatusPage admin panel**.
2. Navigate to **Notifications** in the left sidebar.
3. Click **+ Add Channel**.
4. Fill in the form:

   | Field | Description |
   |-------|-------------|
   | **Name** | A label for this channel, e.g. `Telegram #alerts` |
   | **Type** | Select **Telegram** |
   | **Bot Token** | The token from BotFather |
   | **Chat ID** | The chat ID or `@channelusername` from step 2 |
   | **Message Text** *(optional)* | A line placed above the message — use it for context or mentions. Supports template variables |

5. Toggle **Enabled** on.
6. Toggle **Notify on recovery** if you want a message when the monitor comes back up.
7. Click **Create Channel**.

Then assign the channel to a monitor in the monitor's **Alerts** panel, exactly as for any other channel (see [Notification channels](notification-channels.md)).

---

## Step 4 — Send a test notification

1. Go back to **Notifications**.
2. Click the edit icon on your Telegram channel.
3. Click **Send test (saved settings)** at the bottom of the form. The button sends the saved channel, so save any changes first.
4. Check Telegram — a test message should appear within a few seconds.

---

## Message Text and template variables

The **Message Text** field is placed as a plain line above the message, cut to 1000 characters. Template variables work in it (see [Template variables](notification-channels.md#template-variables)). The whole line is sent as text, not as Telegram HTML, so `<`, `>` and `&` in it or in an error message are shown literally.

Example — mention a person in a group:

```
@alice {{monitor_name}} is {{status}}
```

Messages are limited by Telegram to 4096 characters. When an error message would exceed the limit, it is cut and ends with `…`.

---

## Troubleshooting

A failed delivery shows the status code followed by Telegram's own description (for example `HTTP 400: Bad Request: chat not found`), which tells the causes below apart.

**`Telegram API returned HTTP 404`**
- The token is malformed, for example with a leading or trailing space. Paste it again.

**`Telegram API returned HTTP 401`**
- The bot token is wrong or was revoked. Check it with BotFather (`/mybots` → your bot → **API Token**) and update the channel.

**`Telegram API returned HTTP 400`**
- The chat ID is wrong, or the bot has not been started or added to that chat yet. Send the bot a message (private chat) or re-add it (group), then retry.

**`Telegram API returned HTTP 403`**
- The bot was blocked by the user, removed from the group, or has no permission to post in the channel.

**`Telegram API returned HTTP 429`**
- Telegram is rate limiting the bot. The delivery is retried automatically; use [alert hygiene](alert-hygiene.md) grouping or a rate cap if a burst of alerts is common.

The error text never contains the bot token.
