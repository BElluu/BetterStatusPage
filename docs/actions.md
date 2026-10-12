# Actions

> [!WARNING]
> **Not released yet.** Actions are not in a published release. To try them, build the image yourself from the `main` branch (see [Deployment](deployment.md)).

An action sends an HTTP request when a monitor **stays down** or **comes back up**. Where a [notification channel](notification-channels.md) tells people something happened, an action changes something outside BetterStatusPage: it starts a failover job, wakes a standby server, or switches a feature flag.

Actions live under *Admin → Alerts → **Actions*** and are managed by administrators only. You create an action once, then link it to as many monitors as you like in the monitor's form.

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

The URL, the header values and the body accept the [template variables](#template-variables) below.

An answer with a `2xx` status counts as success. Anything else, and a request that takes longer than 15 seconds, is a failure.

**Run now (saved settings)** in the form sends the saved request once, with sample values. It is the real request: whatever it triggers starts.

---

## Linking an action to a monitor

Open the monitor's form and choose the **Actions** tab (shown to administrators). Each link has:

| Setting | Meaning |
| --- | --- |
| **When monitor is** | `down`, or `back up` |
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

A variable that does not exist is left as written. In the body, values are escaped so they stay valid inside a JSON string.

---

## Retries and run history

A failed run is tried **3 times** in total: the second attempt a minute after the first, the third five minutes after the second. The run history shows every run with its status:

| Status | Meaning |
| --- | --- |
| `pending` | Waiting for its delay, or for the next attempt after a failure |
| `succeeded` | The request was answered with a `2xx` status |
| `failed` | All three attempts failed; the last error is shown |
| `cancelled` | The monitor left the status first, or the action, its link or the monitor was removed. The reason is shown |

Finished runs are kept for 180 days. The run history is in *Admin → Alerts → **Delivery history** → **Actions*** (administrators only), with filters by status and action, and **Run history** on the Actions page opens it.

---

## Example: start a standby server when the primary is down

A Jenkins job starts the standby server `VM2` when `VM1` fails.

1. Create the action **Start VM2**: method `POST`, URL `https://jenkins.example.com/job/start-vm2/build`, and a header `Authorization` with `Basic <base64 of user:API token>`. Jenkins accepts a user and API token as Basic authentication.
2. Create the action **Stop VM2** the same way for the job that shuts the standby down.
3. In the form of the `VM1` monitor, open **Actions** and link **Start VM2** when the monitor is **down** after `5` minutes, with a cooldown of `60`. Link **Stop VM2** when the monitor is **back up** after `0` minutes.

If `VM1` is down for five minutes without recovering, the job starts `VM2`. If it recovers in the meantime, nothing happens. When `VM1` is back, `VM2` is stopped.

---

## Security

- Only administrators can create, change, test or link actions, and see the run history. An [API token](api.md#permissions) needs the `actions` permission.
- Credential-looking headers are masked in the panel and the API. Sending the mask back keeps the stored value. A save that changes the URL but keeps a masked secret is refused, so a stored secret cannot be sent to another address: enter it again.
- Put secrets in a header, not in the URL: the URL is shown in clear text to every administrator and returned by the API.
- The request configuration, including header values, is stored in the database as plain JSON, like the headers of a webhook channel. It is not read from the vault.
- A request can go to any address the server can reach, internal ones included. That is what makes an action useful for a Jenkins on a private network, so give the permission only to people who may start those jobs.

---

## Limits

- An action sends an HTTP request only. Running a script on the server is not supported.
- Actions are not part of the [configuration export and import](configuration-as-code.md) yet.
