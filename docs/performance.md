# Performance

> [!WARNING]
> **Not released yet.** The benchmark script is only in the `main` branch; build the image yourself from the `main` branch (see [Deployment](deployment.md)).

How BetterStatusPage behaves with many monitors, measured with the real scheduler, write path and public API on a SQLite file. Run it yourself with `npm run bench -- --monitors=100 --days=90 --interval=60` (it uses a temporary database and never touches your data).

**Setup of the numbers below:** Node 26.10, AMD Ryzen 7 7700 (16 threads), 32 GB RAM, Windows 11, NVMe disk; HTTPS monitors against a local endpoint answering in 20 ms; every monitor checked every 60 s and 90 days of history kept. Absolute numbers depend on your hardware, a container on a small VPS will be slower. Compare the shape, not the milliseconds.

## Result

| Monitors | Result rows | Database | Tick, all due (healthy) | Write per check | `uptime 90d` per monitor | Status page, cold uptime for all | First start after the upgrade |
|---|---|---|---|---|---|---|---|
| 10 | 1.3 M | 55 MB | 76 ms | 0.8 ms | 0.3 ms | 3 ms | 0.5 s |
| 25 | 3.2 M | 139 MB | 141 ms | 0.8 ms | 0.3 ms | 8 ms | 1.3 s |
| 100 | 13 M | 565 MB | 345 ms | 0.8 ms | 0.3 ms | 38 ms | 5.2 s |
| 250 | 32 M | 1.5 GB | 890 ms | 0.8 ms | 0.3 ms | 87 ms | 15 s |

At 100 monitors the instance needs 1.7 writes per second and manages about 1,250, so checking itself is not the limit. The daily uptime reads from the daily totals (below), so what the status page asks for no longer grows with the history.

## Checks

- A tick with 100 due monitors and healthy endpoints takes about 350 ms.
- Scheduled checks share a limit of `MONITOR_CHECK_CONCURRENCY` slots (default 20), counted across all ticks. A slow or hanging check holds one slot and the rest wait in the order they became due. With 10% of monitors hanging until a 3 s timeout, a tick of 100 monitors takes **3.3 s**. In 0.6.0 and earlier the checks ran in chunks that each waited for their slowest check, which made the same tick take 15 s, and the limit applied to each tick separately, so ticks that overlapped could run more checks at once.
- 100 hanging checks spread over two overlapping ticks never ran more than 20 at once and took 5.5 s (the ideal for 20 slots is 5 s).
- **Check now** does not wait for a slot, because someone is waiting for the answer. A monitor that is already queued or running is not checked a second time.
- Recording one check (the result, the daily totals and the monitor's new state, saved in one transaction) takes about 0.8 ms. Before the daily totals it took 0.6 ms: keeping them current costs 0.1 to 0.2 ms per check. `synchronous = NORMAL` would make it about 0.4 ms, which does not matter at this load.

## Daily totals

The database keeps the checks of every monitor counted per UTC day (`monitor_daily_results`: how many checks, how many up, how many in maintenance, the response times). Triggers on the results table update the counts whenever a result is added, changed or removed, so retention, a deleted monitor and the confirmation of a failure streak keep them right without any code of the application doing it.

- The 90-day uptime of a monitor, the status page bars, the uptime report and the daily bars of the monitor statistics read from this table: 0.3 ms per monitor at every size above, where counting the results took 33 ms at 100 monitors and grew with the history.
- A cold view of the status page (the uptime of every monitor, nothing cached) took 3.3 s at 100 monitors and 8.3 s at 250 before, and takes 38 ms and 87 ms now. The static fallback, which reads the uptime of every monitor on each push, gets the same relief.
- The first start after the upgrade counts the results that are already there, in one transaction. It took 5.2 s at 13 million results and 15 s at 32 million; a small instance does not notice it. If it is interrupted, nothing is kept and the next start does it again.
- The benchmark checks the table against the results after the build and again after the checks, writes and retention, and fails if they differ.

## Reading history

The database driver is synchronous: while a query runs, nothing else in the process runs.

| Query | 100 monitors, 90 days |
|---|---|
| Public status (all monitors) | 0.4 ms |
| Daily uptime for 90 days (one monitor) | 0.3 ms |
| History, 24 h | 1.5 ms |
| History, 7 d | 11 ms |
| Monitor statistics, 24 h / 7 d / 30 d | 4.5 / 27 / 119 ms |

Response time statistics (average, percentiles, charts) are still counted from the results, so the 7-day and 30-day views of a monitor take longer as the history grows.

## Retention

Deleting the results older than `MONITOR_RESULT_RETENTION_DAYS` (about one day of results a day) took 0.9 s at 100 monitors and 2.2 s at 250. It was 0.7 s and 1.9 s before the daily totals: the triggers adjust them for each deleted result.
