# Alert hygiene

The most common reason people stop trusting a monitoring tool is that it alerts too much. One
flapping endpoint, one bad deploy, one night shift — and the alert channel gets muted forever.

BetterStatusPage has four controls for this. **All of them are off by default**, so upgrading an
existing instance changes nothing about when or how you are notified.

| Control | Where it lives | What it does |
| --- | --- | --- |
| Failure / recovery thresholds | Per monitor | Requires N consecutive checks before notifying |
| Quiet hours | Per channel | Holds or drops notifications during a local-time window |
| Rate cap | Per channel | Limits how often one monitor may alert on that channel |
| Grouping | Per channel | Collapses a burst of simultaneous events into one digest |

Anything the rules stop is still recorded in **Notifications → Delivery history** with the reason,
so you can always see what was *not* sent.

---

## Failure and recovery thresholds

*Admin → Monitors → edit a monitor → **Alert after (checks)** / **Recover after (checks)***

A monitor only alerts once it has failed the configured number of checks **in a row**. A single
successful check resets the streak, so an endpoint that flaps between up and down never alerts at
all.

```
failureThreshold = 3, interval = 60s

check:  down   down   up     down   down   down
streak: 1      2      reset  1      2      3  → alert
```

The two thresholds are independent: `failureThreshold` gates the alert, `recoveryThreshold` gates
the all-clear. Both default to `1`, which means "notify on every status change" — the behaviour
before this feature existed.

Two things worth knowing:

- **The public status page is not debounced.** `currentStatus` still follows every check
  immediately; only notifications wait. Visitors see reality, your phone sees confirmed reality.
- **Severity changes stay immediate.** A monitor that is already confirmed `degraded` and turns
  `down` alerts on the next check regardless of the threshold — you have already been paged, so
  the escalation is not news you need debounced.

Do not confuse thresholds with **Attempts** (`retries`). Attempts are retries *inside one check*,
seconds apart, to ride out a single dropped packet. Thresholds span *whole check intervals*. They
compose: `Attempts = 2, Alert after = 3` means six probes across three intervals before anyone is
told.

### Choosing a value

`failureThreshold × intervalSecs` is roughly how long an outage must last before you hear about
it. With a 60 s interval, `3` means "down for ~3 minutes". Start there for anything flaky over the
public internet; keep `1` for things where every second counts.

---

## Quiet hours

*Admin → Notifications → edit a channel → **Quiet hours***

A recurring local-time window during which the channel goes silent. Configure the start, the end,
and the IANA timezone the window is expressed in (`Europe/Warsaw`, `America/New_York`, …) — the
server's own timezone is irrelevant, so a channel for an on-call team in another country behaves
the way that team expects.

A window whose end is at or before its start wraps past midnight, so `22:00 → 07:00` is the night.

Two modes:

- **Hold** (default) — notifications queue up and are delivered the moment the window ends. Nothing
  is lost; you just are not woken up. If grouping is also on, everything held for the same window is
  released as a single digest.
- **Drop** — notifications are discarded. Use this for a purely informational channel; use *Hold*
  for anything resembling on-call.

Quiet hours apply to the **channel**, not the monitor. The usual pattern is a channel with quiet
hours for the noisy-but-not-urgent monitors and a second channel without them for the critical ones.

> DST is handled: the window is evaluated against the wall clock in the chosen timezone on each
> check, and the release time is recomputed if the clock shifts inside the window.

---

## Rate cap per monitor

*Admin → Notifications → edit a channel → **Rate cap per monitor***

"No more than X alerts from this monitor per Y minutes." Once the cap is hit, further alerts from
that monitor to that channel are recorded as suppressed until the window rolls forward.

The cap counts **per monitor**, so a noisy monitor cannot use up another one's budget.

**Recoveries are never capped.** The all-clear always gets through, otherwise you could be left
believing an outage is still running.

A sensible starting point is `3 alerts / 60 minutes`: enough to notice a genuinely thrashing
service, not enough to bury the channel.

---

## Grouping bursts into one digest

*Admin → Notifications → edit a channel → **Group bursts into one message***

When a shared dependency dies, twenty monitors go down within seconds and produce twenty messages.
Grouping turns that into one.

How it works: the first event opens a window of `windowSeconds`. Every event for the same channel
and event type that arrives while the window is open joins it. When the window closes:

- **at least `minMonitors` distinct monitors** are in it → one digest notification is sent and the
  individual events are marked as suppressed (reason: *merged into digest*);
- **fewer than that** → the events are released and sent individually, exactly as they would have
  been.

So grouping never swallows a lone alert. The only cost is latency: with grouping on, *every*
notification on that channel is delayed by up to `windowSeconds`, plus up to 30 s for the delivery
worker's next pass.

Alerts and recoveries are grouped separately, so a digest is never a confusing mix of the two — and
a recovery can never overtake the alert it belongs to.

A digest fills these template variables:

| Variable | Digest value |
| --- | --- |
| `{{monitor_name}}` | `5 monitors` |
| `{{monitor_list}}` | `Checkout API, Search API, …` |
| `{{affected_count}}` | `5` |
| `{{status}}` | the worst status in the group |
| `{{error_message}}` | one line per monitor, with its own error |
| `{{monitor_type}}` | `group` |

`{{monitor_list}}` and `{{affected_count}}` are also filled in for ordinary single-monitor
notifications (as the monitor's own name and `1`), so a template that uses them is safe either way.

---

## How the rules combine

For each event, on each linked channel, in this order:

1. **Recovery filter** — skip if this is a recovery and the channel has recovery notifications off.
2. **Rate cap** — over the limit? Suppressed, reason *throttled*. Stops here.
3. **Quiet hours** — inside the window? Either suppressed (reason *quiet-hours*) or scheduled for
   the end of the window.
4. **Grouping** — joins or opens a digest window; the delivery is scheduled for whichever is later,
   the end of the digest window or the end of quiet hours.

Everything upstream of this still applies unchanged: maintenance windows suppress notifications
entirely, and a monitor whose declared dependency is already down reports `affected` and stays
quiet so the root cause fires the only alert.

---

## Reading the delivery history

*Admin → Notifications → Delivery history*

Suppressed notifications are listed alongside delivered ones with a **Suppressed** status and the
reason. Filter on `Suppressed` to answer "what did the rules eat last night?" — if the answer is
something you needed, loosen the rule.

Deliveries still waiting for a quiet window or a digest window show as **Pending** with a
*Held until …* timestamp.

---

## API

Thresholds are plain fields on the monitor:

```http
PATCH /api/v1/admin/monitors/:id
{ "failureThreshold": 3, "recoveryThreshold": 1 }
```

The channel policy is one nested object; omitted fields fall back to defaults, and out-of-range
values are clamped rather than rejected:

```http
PATCH /api/v1/admin/notifications/channels/:id
{
  "alertPolicy": {
    "quietHours": { "enabled": true, "start": "22:00", "end": "07:00",
                    "timezone": "Europe/Warsaw", "mode": "defer" },
    "throttle":   { "enabled": true, "maxAlerts": 3, "windowMinutes": 60 },
    "grouping":   { "enabled": true, "minMonitors": 3, "windowSeconds": 60 }
  }
}
```

Ranges: thresholds `1–20`, `maxAlerts` `1–100`, `windowMinutes` `1–1440`, `minMonitors` `2–100`,
`windowSeconds` `10–900`. Every change is written to the audit log.
