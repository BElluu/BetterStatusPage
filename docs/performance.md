# Performance

> [!WARNING]
> **Not released yet.** The benchmark script is only in the `main` branch; build the image yourself from the `main` branch (see [Deployment](deployment.md)).

How BetterStatusPage behaves with many monitors, measured with the real scheduler, write path and public API on a SQLite file. Run it yourself with `npm run bench -- --monitors=100 --days=90 --interval=60` (it uses a temporary database and never touches your data).

**Setup of the numbers below:** Node 26.10, AMD Ryzen 7 7700 (16 threads), 32 GB RAM, Windows 11, NVMe disk; HTTPS monitors against a local endpoint answering in 20 ms; every monitor checked every 60 s and 90 days of history kept. Absolute numbers depend on your hardware, a container on a small VPS will be slower. Compare the shape, not the milliseconds.

## Result

| Monitors | Result rows | Database | Tick, all due (healthy) | Write per check | `uptime 90d` per monitor | Status page, cold uptime for all |
|---|---|---|---|---|---|---|
| 10 | 1.3 M | 55 MB | 60 ms | 0.7 ms | 33 ms | 0.3 s |
| 25 | 3.2 M | 139 MB | 117 ms | 0.7 ms | 33 ms | 0.8 s |
| 100 | 13 M | 565 MB | 280 ms | 0.6 ms | 33 ms | 3.3 s |
| 250 | 32 M | 1.5 GB | 700 ms | 0.7 ms | 33 ms | 8.3 s |

At 100 monitors the instance needs 1.7 writes per second and manages about 1,500, so checking itself is not the limit. What grows is the data behind the reads.

## Checks

- A tick with 100 due monitors and healthy endpoints takes about 350 ms.
- Scheduled checks share a limit of `MONITOR_CHECK_CONCURRENCY` slots (default 20), counted across all ticks. A slow or hanging check holds one slot and the rest wait in the order they became due. With 10% of monitors hanging until a 3 s timeout, a tick of 100 monitors takes **3.3 s**. In 0.6.0 and earlier the checks ran in chunks that each waited for their slowest check, which made the same tick take 15 s, and the limit applied to each tick separately, so ticks that overlapped could run more checks at once.
- 100 hanging checks spread over two overlapping ticks never ran more than 20 at once and took 5.5 s (the ideal for 20 slots is 5 s).
- **Check now** does not wait for a slot, because someone is waiting for the answer. A monitor that is already queued or running is not checked a second time.
- Recording one check (the result and the monitor's new state, saved in one transaction) takes about 0.6 ms; saved as separate statements it took 0.9 ms. `synchronous = NORMAL` would make it about 0.3 ms, which does not matter at this load.

## Reading history

The database driver is synchronous: while a query runs, nothing else in the process runs.

| Query | 100 monitors, 90 days |
|---|---|
| Public status (all monitors) | 0.5 ms |
| History, 24 h | 1.7 ms |
| History, 7 d | 11 ms |
| Monitor statistics, 24 h / 7 d / 30 d | 4.5 / 26 / 123 ms |
| Daily uptime for 90 days (one monitor) | 35 ms |

The status page asks for the 90-day uptime of every monitor and the answer is cached for 30 s, so a page that is viewed all the time spends about 3.5 s of every 30 s inside these queries, in 35 ms slices that also delay checks and live updates.

## Retention

Deleting one day of results (`MONITOR_RESULT_RETENTION_DAYS`) took 0.8 s at 100 monitors and 1.9 s at 250.
