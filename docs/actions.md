# Actions

> [!WARNING]
> **Not released yet.** Actions are not in a published release. To try them, build the image yourself from the `main` branch (see [Deployment](deployment.md)).

An action sends an HTTP request when a monitor **stays down** or **comes back up**. Where a [notification channel](notification-channels.md) tells people something happened, an action changes something outside BetterStatusPage: it starts a failover job, wakes a standby server, or switches a feature flag.

Actions live under *Admin → Alerts → **Actions*** and are managed by administrators only. You create an action once, then link it to as many monitors as you like in the monitor's form.

**How it fits together**

1. **Create the action**: the request to send (URL, method, headers, JSON body). Tokens and passwords come from a [vault](#secrets-from-the-vault), not from the form fields.
2. **Link it to a monitor** in the monitor's **Actions** tab: for which status (`down` or back `up`), after how many minutes, and with what [cooldown](#linking-an-action-to-a-monitor).
3. **When the monitor reaches that status and holds it**, a run is queued, sent (up to [3 attempts](#retries-and-run-history)) and recorded in the run history.
4. **If a run fails for good**, the channels you chose are [notified](#when-a-run-fails), and you can retry the run by hand.

---

## Creating an action

*Actions → Add Action* takes the same request fields as a [webhook channel](notification-channels.md#webhook):

| Field | Meaning |
| --- | --- |
| **Name** | Shown in the monitor form and the run history |
| **URL** | Must start with `http://` or `https://` |
| **Method** | `GET`, `POST`, `PUT` or `PATCH` |
| **Headers** | Optional. Values of headers that look like credentials (`Authorization`, `X-Api-Key`, ...) are shown masked once saved |
| **Body (JSON)** | Optional JSON, for `POST`, `PUT` and `PATCH`. It is sent with `Content-Type: application/json`, and the variables go inside string values, for example `{"monitor": "{{monitor_name}}"}`. A body that is not valid JSON is refused when you save |
| **Enabled** | A disabled action is never run |

**Where variables work.** The [template variables](#template-variables) below, and the [secret placeholders](#secrets-from-the-vault), can be used in the **URL**, in the **values of headers** (not in header names) and in the **body**. The *Available variables* box in the form is shared with webhook channels, so it also lists names an action never fills in (`{{monitor_list}}`, `{{affected_count}}` and the certificate ones); use the ones in the table below.

An answer with a `2xx` status counts as success. Anything else, and a request that takes longer than 15 seconds, is a failure. **Redirects are not followed**: a `3xx` answer is a failure (`HTTP 302 (redirect not followed)`), so headers and body never go to another address than the one you configured. Use the final URL.

**Run now (saved settings)** in the form sends the saved request once, with sample values. It is the real request: whatever it triggers starts. The form then shows the HTTP status and the first part of the answer, also when the request failed, so you can see what the target said.

### Secrets from the vault

A token should not be typed into a header, the URL or the body, where it would be stored as plain text. Open the **Secrets** tab at the right edge of the form, add a secret for each one the request needs, give it a **name** (letters and digits) and pick a **Vault** and a **Secret** of a [vault](vault.md). Then use its placeholder in the URL, a header value or the body. With the name `jenkins`:

| Secret type | Placeholders |
| --- | --- |
| Secure Value | `{{secret_jenkins}}` |
| User / Password | `{{secret_jenkins_basic}}` (the Base64 of `user:password`, for `Authorization: Basic {{secret_jenkins_basic}}`), `{{secret_jenkins_username}}`, `{{secret_jenkins_password}}` |
| JSON | `{{secret_jenkins_<key>}}` for every key of the object |

An action can read up to 10 secrets, each under its own name, for example a token in one header and a user and password in another. Every secret needs a placeholder that uses it, and every `{{secret_…}}` placeholder needs a secret of that name: the form and the API refuse anything else, and a placeholder that its secret's type does not offer (`_basic` on a Secure Value, say).

The secrets are read when the request is sent. They are kept in memory for that request only: not stored with the run, not shown in the run history or the failure notification, and removed (as `[secret]`) from the answer shown in the test result and from error messages. This is best effort: a secret shorter than 4 characters is not removed, and a target that changes a secret before it echoes it back (hashes it, for example) cannot be recognised. If a secret or its vault cannot be read when a run is due, the attempt fails with that reason and is retried like any other. The values of variables such as `{{monitor_name}}` are URL-encoded when they are put in the URL, and a placeholder cannot be part of the host of an action that reads a vault secret, so a secret can only go to the address you configured.

---

## Linking an action to a monitor

Open the monitor's form and choose the **Actions** tab (shown to administrators). Each link has:

| Setting | Meaning |
| --- | --- |
| **When** | `down`, or `back up` |
| **After (min)** | How long to wait after the monitor reached that status before running. `0` runs at once |
| **Cooldown (min)** | The same action does not run again for this monitor and status within this many minutes. `0` has no limit |

The same action can be linked once per status, so one action can serve both `down` and `back up` with different delays.

### When an action runs

- **The monitor's confirmed status counts**, the same as for notifications: it is the status after **Alert after (checks)** and **Recover after (checks)** are met. Raise the thresholds to keep a flapping check from triggering an action. During a [maintenance window](incidents-and-maintenance.md) the confirmed status is not updated, and a run that comes due inside the window is cancelled, so an action never starts while you are working on the service.
- **A `down` action waits for its delay and is dropped if the monitor recovers first.** The status, the maintenance windows and the link are checked again just before every attempt.
- **A `back up` action runs after an outage**, that is when the monitor was down, degraded or affected by a dependency. It does not run for a monitor's first successful check.
- **Waiting runs survive a restart.** They are stored in the database and sent by the same background worker as notification retries, which runs every 30 seconds, so a run can start up to about 30 seconds after it is due.
- Removing the link, deleting the action or deleting the monitor cancels the runs that are still waiting.

---

## Template variables

| Variable | Value |
| --- | --- |
| `{{monitor_name}}` | Name of the monitor |
| `{{monitor_type}}` | Type of the monitor (`https`, `sqlserver`, ...) |
| `{{status}}` | The status that triggered the action: `down` or `up` |
| `{{previous_status}}` | The status before it |
| `{{error_message}}` | The error of the failing check, empty for `up` |
| `{{checked_at}}` | Time of the check, ISO 8601 |
| `{{event_type}}` | `alert` (down), `recovery` (up) or `test` (Run now) |

A variable that does not exist is left as written. How a value is put in depends on where it goes: in the **URL** it is URL-encoded, in the **body** it is escaped so it stays valid inside a JSON string, in a **header value** it is used as it is. The placeholders of [vault secrets](#secrets-from-the-vault) (`{{secret_<name>}}` and friends) work in the same three places.

---

## Retries and run history

A failed run is tried **3 times** in total: the second attempt a minute after the first, the third five minutes after the second. The run history shows every run with its status, and **Retry** on a failed run gives it another round of 3 attempts. The usual checks still apply, so a run whose monitor has recovered since, that lies in a maintenance window or whose link is gone is cancelled with the reason.

| Status | Meaning |
| --- | --- |
| `pending` | Waiting for its delay, or for the next attempt after a failure |
| `succeeded` | The request was answered with a `2xx` status |
| `failed` | All three attempts failed; the last error is shown |
| `cancelled` | The monitor left the status first, or the action, its link or the monitor was removed. The reason is shown |

Finished runs are kept for 180 days. The run history is in *Admin → Alerts → **Delivery history** → **Actions*** (administrators only), with filters by status and action, and **Run history** on the Actions page opens it.

### When a run fails

In the action's form, the **Notify when a run fails** tab at the right edge lists your [notification channels](notification-channels.md). Each one you tick is told **once**, after the last attempt has failed: nothing is sent for a success, a cancelled run or **Run now**. Disabled channels are skipped. The message names the action, the monitor, the status that triggered it and the error of the last attempt, never the request. See the [Action failed event](notification-channels.md#action-failures-only).

---

## Example: start a standby server when the primary is down

A Jenkins job starts the standby server `VM2` when `VM1` fails.

1. In a [vault](vault.md), create a **User / Password** secret `jenkins` with the Jenkins user and its API token. Create the action **Start VM2**: method `POST`, URL `https://jenkins.example.com/job/start-vm2/build`, a header `Authorization` with the value `Basic {{secret_jenkins_basic}}`, and in the **Secrets** tab a secret named `jenkins` set to that vault secret. Jenkins accepts a user and API token as Basic authentication. Tick a channel in the **Notify when a run fails** tab so someone is told if the job cannot be started.
2. Create the action **Stop VM2** the same way for the job that shuts the standby down.
3. In the form of the `VM1` monitor, open **Actions** and link **Start VM2** when the monitor is **down** after `5` minutes, with a cooldown of `60`. Link **Stop VM2** when the monitor is **back up** after `0` minutes.

If `VM1` is down for five minutes without recovering, the job starts `VM2`. If it recovers in the meantime, nothing happens. When `VM1` is back, `VM2` is stopped.

---

## Security

- Only administrators can create, change, test, retry or link actions, and see the run history. The **Action failed** entries of the notification history are hidden from everyone else for the same reason: they quote what the target answered. An [API token](api.md#permissions) needs the `actions` permission, `channels:write` to choose the failure channels, and `vault:use` to add or change a vault reference.
- Credential-looking headers are masked in the panel and the API. Sending the mask back keeps the stored value. A save that changes the URL but keeps a masked secret is refused, so a stored secret cannot be sent to another address: enter it again.
- **Keep credentials in a [vault secret](#secrets-from-the-vault).** Whatever you type into a header, the URL or the body is stored in the database as plain JSON, like the headers of a webhook channel, and the URL is shown in clear text to every administrator and returned by the API. The form warns when a header or the URL looks like it holds a credential.
- A request can go to any address the server can reach, internal ones included. That is what makes an action useful for a Jenkins on a private network, so give the permission only to people who may start those jobs. Redirects are not followed.

---

## Configuration as code

Actions are exported and imported like monitors and channels, as `Action` documents with a `key`, and a monitor lists the actions it runs in an `actions` list. See [Configuration as code](configuration-as-code.md).

---

## Limits

- An action sends an HTTP request only. Running a script on the server is not supported.
- After the application was stopped for a while, a run that is due is sent as soon as it is back up, based on the monitor's status from before the stop, until the next check of the monitor has run.
