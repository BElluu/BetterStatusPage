# Users and roles

Every person who signs in to BetterStatusPage has their own account with one of four roles: `admin`, `operator`, `branding` or `viewer`. This guide covers what each role can do, how administrators manage users, passwords and two-factor authentication, and the two admin pages that watch the instance itself: the **Audit Log** and **System Health**.

## Roles

| Role | Meant for |
|------|-----------|
| **admin** | Full access, including users, sign-in settings, vaults, the audit log, backups and system health. |
| **operator** | Day-to-day work: monitors, incidents, maintenance, notifications, subscribers, and the status page's look. |
| **branding** | The status page's look only: page builder, branding and localization. |
| **viewer** | Viewing a [private status page](private-status-page.md). No access to the admin console. |

The role is checked by the API on every request, not only by the admin panel, so hiding a menu item is never the only protection.

### Permission matrix

| Area | admin | operator | branding | viewer |
|------|:-----:|:--------:|:--------:|:------:|
| **Dashboard** | Yes | Yes | No | No |
| [**Monitors**](monitors.md), including the live status stream | Yes | Yes | No | No |
| [**Incidents**](incidents-and-maintenance.md) | Yes | Yes | No | No |
| [**Maintenance**](incidents-and-maintenance.md) | Yes | Yes | No | No |
| [**Notifications**](notification-channels.md): channels, SMTP settings, delivery history | Yes | Yes | No | No |
| [**Subscribers**](subscriptions.md) and subscription settings | Yes | Yes | No | No |
| [**Page Builder**](customizing-the-status-page.md) | Yes | Yes | Yes | No |
| [**Branding**](customizing-the-status-page.md) | Yes | Yes | Yes | No |
| **Localization** | Yes | Yes | Yes | No |
| **Settings** (own password, 2FA, sessions) | Yes | Yes | Yes | No |
| Pick a vault secret in a monitor (names only, never values) | Yes | Yes | No | No |
| [**Vault**](vault.md): create and edit vaults and secrets | Yes | No | No | No |
| **Users**, **Single sign-on**, **Status page access** | Yes | No | No | No |
| **Audit Log** | Yes | No | No | No |
| [**Backups**](backup-restore.md) | Yes | No | No | No |
| **System Health** | Yes | No | No | No |
| [Private status page](private-status-page.md) | Yes | Yes | Yes | Yes |

The sidebar shows only the pages a role can open. Opening another page's address sends the user back to their start page: **Dashboard** for admins and operators, **Branding** for the branding role. A viewer who signs in on the admin sign-in page, or opens any admin address, is taken to the status page.

## The first administrator

The first account is created by the setup wizard at `/admin` on a new instance, see [Open the setup wizard](deployment.md#4-open-the-setup-wizard). It asks for an email and a password of 8 to 128 characters, gives that account the `admin` role and signs you in. The wizard runs only once; every further account is created in **Users**.

## Managing users

Open **Users** (administrators only). The table lists every account with its role and a status:

| Status | Meaning |
|--------|---------|
| **Temp password** | The user has not yet replaced the temporary password they were given. |
| **Active** | The user has their own password, or signs in through SSO. |
| **2FA** | Two-factor authentication is turned on. |
| **SSO** | The account is linked to an identity-provider account, see [Single sign-on](single-sign-on.md#how-it-works). |

### Create a user

1. Click **New User**, enter the email and pick a role (default **Branding**).
2. Click **Create**. A 12-character temporary password is shown **once**, with a copy button. Send it to the user.

On their first sign-in the user must replace the temporary password before they can do anything else; the API refuses every other request until they do. A user who signs in through [single sign-on](single-sign-on.md#how-it-works) never needs the temporary password: the SSO sign-in revokes it.

Each email can have only one account.

### Change a role

Click another role in the user's row. Moving a user to a role with less access asks for confirmation first. The change ends all of the user's sessions at once, so they sign in again with the new role.

### Reset a password

Click **Reset password** in the user's row and confirm. The old password stops working, all of the user's sessions end, and a new temporary password is shown once. The user replaces it on their next sign-in. Resetting a password does not change the user's 2FA.

### Reset two-factor authentication

When a user has lost their authenticator app and their recovery codes, click **Reset 2FA** in their row. See [Recover access when 2FA is lost](deployment.md#recover-access-when-2fa-is-lost) for the details and for the command-line reset when no administrator can sign in.

### Delete a user

Click **Delete user** and confirm. The account is removed and all of its sessions end immediately. There is no separate "disabled" state: to take access away, delete the account. Audit-log entries the user made stay, with their email.

### Protection against locking yourself out

You cannot change your own role, delete your own account, or reset your own 2FA from **Users** (turn it off in **Settings** instead). Since only administrators can change roles, the administrator doing it always remains, so the instance always keeps at least one admin.

### Confirming sensitive actions

Resetting another user's 2FA, turning your own 2FA on or off, changing your password and changing the sign-in settings ask you to confirm who you are: with your current password, or, when you signed in through SSO, by signing in again at the identity provider. See [Confirming sensitive actions](single-sign-on.md#confirming-sensitive-actions). **Reset 2FA** and saving the sign-in settings accept at most 5 attempts per 15 minutes.

## Your own account

**Settings** (the link at the bottom of the sidebar) is available to admins, operators and the branding role. It has three sections.

### Change your password

Enter your current password (or [confirm through SSO](single-sign-on.md#confirming-sensitive-actions)), then the new password twice, and click **Update password**.

- Passwords must be **8 to 128 characters**. There are no other composition rules.
- Changing the password signs out every other session. The browser you changed it in stays signed in.
- The change is written to the audit log; the password itself never is.

The forced change after a temporary password (**Set your password**) works the same way but does not ask for the current password.

Viewers have no **Settings** page. They replace a temporary password on the status page's sign-in screen, and an administrator resets their password when they forget it.

### Sign out everywhere

**Sign out everywhere** ends this session and every other session of your account. Sessions otherwise last 12 hours from sign-in.

### Sign-in limits

Password sign-in, the authentication-code step and the SSO endpoints accept at most **10 requests per 15 minutes** from one client address. After that they answer `429` until the window passes. There is no per-account lockout, so a flood of wrong passwords for someone's email does not lock that person out. Every refused sign-in is recorded in the audit log, see [Why a sign-in was refused](single-sign-on.md#why-a-sign-in-was-refused).

To make sure an SSO-only setup cannot lock everyone out, see [Password sign-in and lockout protection](single-sign-on.md#password-sign-in-and-lockout-protection).

## Two-factor authentication

Two-factor authentication (2FA) adds a 6-digit code from an authenticator app to every sign-in. It uses standard TOTP (30-second codes, SHA-1), so any authenticator app works.

### Turn it on

1. Open **Settings → Two-factor authentication**.
2. Confirm who you are (current password, or SSO) and click **Set up 2FA**.
3. Scan the QR code with your authenticator app. If you cannot scan it, open **Cannot scan the QR code?** and type the setup key, or use **Open in authenticator app**.
4. Enter the code the app shows and click **Verify and enable**. The setup must be finished within 10 minutes.
5. Eight **recovery codes** are shown, once. Copy them with **Copy codes** and store them somewhere safe.

Turning 2FA on signs out your other sessions. The secret is stored encrypted with `VAULT_ENCRYPTION_KEY`; recovery codes are stored only as hashes.

### Signing in with 2FA

After the password, or after an SSO sign-in, the sign-in page asks for the **authentication code**. You have 5 minutes for this step. Instead of the app's code you can enter one of your recovery codes. Each recovery code works once; used codes are removed.

The audit log records whether a sign-in included a code, and a wrong or late code is recorded as `invalid_two_factor_code` or `two_factor_expired`.

### Turn it off

In **Settings → Two-factor authentication**, confirm who you are, enter a current authentication code or a recovery code, and click **Disable 2FA**. This removes the secret and the remaining recovery codes and signs out your other sessions. To get new recovery codes, turn 2FA off and on again.

### Lost your device

Sign in with a recovery code. Without one, an administrator resets your 2FA in **Users**; if nobody can sign in, use the command-line reset. Both are described in [Recover access when 2FA is lost](deployment.md#recover-access-when-2fa-is-lost).

## Audit log

The **Audit Log** (administrators only) records who changed what and when. Each entry has a time, the user's email, an action, the entity and, for most entries, details.

### What is recorded

| Entity | Recorded |
|--------|----------|
| Monitor, Incident, Maintenance | Create, update, delete |
| Notification Channel, SMTP Settings | Create, update, delete |
| Notification delivery | Manual retry of a failed delivery |
| Subscription Settings, Subscriber | Settings changes, subscriber deletion |
| Vault, Vault Secret | Create, update, delete (secret values never) |
| Branding, Layout, Locale | Branding and page builder saves, translation changes |
| User | Create (also viewer accounts created through SSO), role change, password reset, delete |
| Account security (`user-security`) | Password changed, 2FA turned on or off, 2FA reset by an administrator (`admin_recovery`) or from the command line (`emergency_cli`), SSO account linked, temporary password revoked by an SSO sign-in |
| SSO Settings, Status Page Access | Settings changes |
| Backup, backup schedule | Backup created or deleted, schedule changes |
| Sign-in | Every sign-in with a password or SSO: **Allowed** (with the method and whether a 2FA code was used) or **Denied** (with the reason) |

Refused sign-ins have no signed-in user, so they are recorded as user 0 with the email that was entered or that the identity provider sent. The reason codes are listed in [Why a sign-in was refused](single-sign-on.md#why-a-sign-in-was-refused).

### Details and diffs

Click a row to expand it:

- **Updates** show a table of the changed fields with **Before** and **After** values. The row says how many fields changed.
- **Creates and deletes** show a snapshot of the main fields.
- **Sign-ins** show **Show details** (allowed) or **Show reason** (denied).

Any field whose name contains `password`, `secret`, `token`, `authorization`, `cookie`, `credential` or `recoverycode`, and the encrypted vault values and configuration, is stored as `[redacted]`. A changed secret therefore shows up as changed, but its value is never written.

### Filters

Filter by **User** (part of the email), **Entity**, **Action** (**Create**, **Update**, **Delete**, **Allowed**, **Denied**) and a **From** / **To** date range. The list shows 50 entries per page, newest first.

The API behind the page, `GET /api/v1/admin/audit`, takes the same filters as query parameters (`userEmail`, `entityType`, `action`, `from`, `to` in Unix milliseconds, `page`, `limit` up to 100).

### Retention

Entries are never deleted automatically. They are kept in the database and included in [backups](backup-restore.md).

## System Health

**System Health** (administrators only) shows whether this BetterStatusPage instance itself works. It refreshes every 15 seconds, or on **Refresh**. The banner at the top says **BetterStatusPage is healthy** or **BetterStatusPage needs attention**; the instance needs attention when the database is unavailable, the monitor scheduler is in error, or backups are in error.

| Card | Shows | Status |
|------|-------|--------|
| **Application** | Version, process uptime | Always `ok` while the page loads. |
| **Database** | Connection, response time of a test query | `error` when the database does not answer. |
| **Monitor scheduler** | Whether the scheduler runs, configured and overdue monitors, latest stored check, last scheduler tick, its duration, checks due and failed jobs in it | `error` when the scheduler is stopped or its last tick failed; `attention` when checks failed or monitors are overdue. A monitor is overdue when it has never been checked or its last check is older than twice its interval. |
| **Notification delivery** | Pending and failed deliveries, last delivery | `attention` when anything is pending or failed. See [notification channels](notification-channels.md). |
| **Backups** | Automatic schedule, last operation, stored backups, latest backup, last completed operation | `disabled` when the schedule is off; `error` when the last backup failed or the backup folder cannot be read. See [backup and restore](backup-restore.md). |

## Health endpoints for load balancers

Two unauthenticated endpoints sit at the root of the server, outside `/api`:

| Endpoint | Answers | Use it for |
|----------|---------|------------|
| `GET /health` | Always `200 {"status":"ok"}` while the process serves requests. | Liveness: is the process up. The Docker Compose file uses it as the container healthcheck (`wget -qO- http://localhost:3000/health`). |
| `GET /ready` | `200 {"status":"ready"}` after setup is finished and the database answers; otherwise `503 {"status":"not_ready"}`. | Readiness: should traffic go here. Returns `503` until the [setup wizard](deployment.md#4-open-the-setup-wizard) has run. |

Neither endpoint reveals anything beyond these answers. For the detailed view, use the **System Health** page.
