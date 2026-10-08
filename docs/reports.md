# Uptime reports

The status page shows the last 30 days of each monitor as a bar. **Monitoring → Reports** in the admin console goes further back and further into the numbers: pick any date range, see the uptime of every monitor, and download it as CSV for an SLA review or a customer.

> [!WARNING]
> **Not released yet.** Uptime reports are not part of any release so far. To try them, build the image yourself from the `main` branch of the repository (see [Deployment](deployment.md)).

The page is open to the operator role and above (see [Users and roles](users-and-roles.md)).

## Choosing a range

- **From** and **To** are calendar days and both are included. The default is the last 30 days. **Last 7 / 30 / 90 days** are shortcuts.
- **Monitor** limits the report to one monitor; the default is all of them.
- A range can span at most 366 days.
- Days are **UTC days**, the same as the daily bars on the status page.

Check results are kept for 90 days by default (`MONITOR_RESULT_RETENTION_DAYS`, see [Monitors](monitors.md#history)). A report can only cover days that still have results; when your range reaches back further, the page says so. Raise the retention before you need the older numbers, because purged results cannot be recovered.

## What the table shows

One row per monitor for the whole range:

| Column | Meaning |
|--------|---------|
| **Uptime** | Successful checks divided by all checks, to three decimals. `—` when the monitor has no results in the range. |
| **Checks** / **Successful** | The two numbers behind the percentage. |
| **Avg response** | Mean response time of the checks that recorded one. |
| **Incidents** | Incidents linked to the monitor that overlap the range. |

Uptime is counted the same way as on the status page: a failure that the monitor's failure threshold has not confirmed yet does not lower it (see [Alert hygiene](alert-hygiene.md)). Maintenance windows are not subtracted.

## Exporting CSV

Both buttons export the range, and the monitor, that is currently selected. Text a spreadsheet could run as a formula (starting with `=`, `+`, `-` or `@`) is prefixed with an apostrophe.

**Export summary CSV** has one row per monitor, with the columns `monitor_id, monitor, from, to, checks_total, checks_up, uptime_pct, avg_response_ms, incidents`.

**Export daily CSV** has one row per monitor and day, with the columns `monitor_id, monitor, date, checks_total, checks_up, uptime_pct`. Days without results are listed with zero checks and an empty `uptime_pct`, so gaps stay visible.

## API

Both endpoints need an admin session (operator role or higher) and take the same query: `from` and `to` as `YYYY-MM-DD`, and an optional `monitorId`.

- `GET /api/v1/admin/reports/uptime` returns the table as JSON.
- `GET /api/v1/admin/reports/uptime/export` returns the CSV; add `granularity=total` for the summary instead of the daily file.
