# @better-forge/notify

Notification channels, delivery history, retries and alert hygiene.

- `createNotifyEngine` records every notification, applies a channel's quiet hours, rate cap and digest window, sends with retries and sends SMTP mail. The application injects the sender, the digest wording, the names of the events hygiene treats specially and the secret resolver.
- `createTransports` holds the senders for email, webhook, Discord, Teams, Slack, Telegram, ntfy and Pushover. The rich channels format a neutral `Notice` (severity, headline segments, facts, detail, time) that the application builds from its own event.
- `createNotifyRoutes` makes the admin routes: delivery history and retry, channel management with secret masking, and SMTP settings. The application injects audit, identity, secret masking, the vault-use guard, the names its API uses for what a notification is about, and the test sends.
- `createDeliveryWorker` sends the deliveries that came due every 30 seconds and purges old history daily, and runs the extra tasks the application adds to those ticks.
- `defineNotifyTables` / `createNotifyDbModule` define the tables and their migrations; the application passes the names of the columns that identify what a delivery is about.

Depends on: `@better-forge/db`, `@better-forge/contracts`, `@better-forge/vault`, `@better-forge/audit`.
