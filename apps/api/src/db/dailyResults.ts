import type { DatabaseSync } from 'node:sqlite'
import { RESULT_IN_MAINTENANCE, RESULT_UNCONFIRMED } from './resultMarks.js'

/**
 * `monitor_daily_results`: the checks of every monitor counted per UTC day, so that uptime over weeks is read from a
 * few rows instead of aggregated over every result.
 *
 * Triggers on `monitor_results` keep it in step, so every writer is covered by construction: a new result, the
 * retroactive confirmation of a failure streak, retention and the cascade of a deleted monitor. The counting rule is
 * the one of `services/uptimeCounts.ts`; a test compares the two on every combination.
 *
 * Any future rebuild of `monitor_results` (create, copy, drop, rename) drops its triggers and must call
 * `rebuildDailyResults` afterwards.
 */

const DAY_MS = 86_400_000
const TRIGGERS = ['monitor_results_daily_insert', 'monitor_results_daily_update', 'monitor_results_daily_delete']

const CREATE_TABLE = `
CREATE TABLE monitor_daily_results (
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  checks_total INTEGER NOT NULL DEFAULT 0,
  checks_up INTEGER NOT NULL DEFAULT 0,
  maintenance_checks INTEGER NOT NULL DEFAULT 0,
  response_sum INTEGER NOT NULL DEFAULT 0,
  response_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (monitor_id, day)
) WITHOUT ROWID`

/** What one result adds to its day, as SQL over the columns of `row` (a table alias, `NEW` or `OLD`). */
function contribution(row: string) {
  const inMaintenance = `${row}.unconfirmed = ${RESULT_IN_MAINTENANCE}`
  return {
    total: `CASE WHEN ${inMaintenance} THEN 0 ELSE 1 END`,
    up: `CASE WHEN ${inMaintenance} THEN 0 WHEN ${row}.status = 'up' OR ${row}.unconfirmed = ${RESULT_UNCONFIRMED} THEN 1 ELSE 0 END`,
    maintenance: `CASE WHEN ${inMaintenance} THEN 1 ELSE 0 END`,
    responseSum: `coalesce(${row}.response_ms, 0)`,
    responseCount: `CASE WHEN ${row}.response_ms IS NULL THEN 0 ELSE 1 END`,
  }
}

const dayOf = (row: string) => `${row}.checked_at / ${DAY_MS}`

/** Adds the result to its day. */
function addRow(row: string): string {
  const c = contribution(row)
  return `INSERT INTO monitor_daily_results (monitor_id, day, checks_total, checks_up, maintenance_checks, response_sum, response_count)
    VALUES (${row}.monitor_id, ${dayOf(row)}, ${c.total}, ${c.up}, ${c.maintenance}, ${c.responseSum}, ${c.responseCount})
    ON CONFLICT (monitor_id, day) DO UPDATE SET
      checks_total = checks_total + excluded.checks_total,
      checks_up = checks_up + excluded.checks_up,
      maintenance_checks = maintenance_checks + excluded.maintenance_checks,
      response_sum = response_sum + excluded.response_sum,
      response_count = response_count + excluded.response_count;`
}

/**
 * Takes the result off its day. A plain UPDATE, never an upsert: when the monitor itself is being deleted, the day's row
 * may be gone already (its own cascade), and an upsert would then insert a row for a monitor that no longer exists.
 */
function removeRow(row: string): string {
  const c = contribution(row)
  return `UPDATE monitor_daily_results SET
      checks_total = checks_total - (${c.total}),
      checks_up = checks_up - (${c.up}),
      maintenance_checks = maintenance_checks - (${c.maintenance}),
      response_sum = response_sum - (${c.responseSum}),
      response_count = response_count - (${c.responseCount})
    WHERE monitor_id = ${row}.monitor_id AND day = ${dayOf(row)};`
}

const CREATE_TRIGGERS = [
  `CREATE TRIGGER ${TRIGGERS[0]} AFTER INSERT ON monitor_results BEGIN ${addRow('NEW')} END`,
  `CREATE TRIGGER ${TRIGGERS[1]} AFTER UPDATE OF monitor_id, checked_at, status, unconfirmed, response_ms ON monitor_results
   BEGIN ${removeRow('OLD')} ${addRow('NEW')} END`,
  `CREATE TRIGGER ${TRIGGERS[2]} AFTER DELETE ON monitor_results BEGIN ${removeRow('OLD')} END`,
]

/**
 * Drops and rebuilds the table, its backfill and the triggers. Runs inside the caller's transaction (the data
 * migration), so the results written meanwhile are all counted and a failure leaves nothing half done.
 *
 * Results of monitors that no longer exist (a database written while foreign keys were off) are left out: nothing
 * reads them, and the table's foreign key would refuse them.
 */
export function rebuildDailyResults(sqlite: DatabaseSync): void {
  for (const trigger of TRIGGERS) sqlite.exec(`DROP TRIGGER IF EXISTS ${trigger}`)
  sqlite.exec('DROP TABLE IF EXISTS monitor_daily_results')
  sqlite.exec(CREATE_TABLE)
  sqlite.exec(`
INSERT INTO monitor_daily_results (monitor_id, day, checks_total, checks_up, maintenance_checks, response_sum, response_count)
SELECT monitor_id, checked_at / ${DAY_MS},
  sum(${contribution('monitor_results').total}),
  sum(${contribution('monitor_results').up}),
  sum(${contribution('monitor_results').maintenance}),
  sum(${contribution('monitor_results').responseSum}),
  sum(${contribution('monitor_results').responseCount})
FROM monitor_results
WHERE monitor_id IN (SELECT id FROM monitors)
GROUP BY monitor_id, checked_at / ${DAY_MS}`)
  for (const statement of CREATE_TRIGGERS) sqlite.exec(statement)
}

/** Days with no result left; retention leaves them behind at zero. Readers skip them too. */
export function deleteEmptyDailyResults(sqlite: DatabaseSync): void {
  sqlite.exec('DELETE FROM monitor_daily_results WHERE checks_total + maintenance_checks = 0')
}

export interface DailyResultsMismatch {
  side: 'results-only' | 'rollup-only'
  monitorId: number
  day: number
}

/**
 * Compares the table with what the results add up to, in both directions. Empty when it is consistent. Slow on a large
 * database (one pass over all results): for tests and the benchmark, not for requests.
 */
export function findDailyResultsMismatches(sqlite: DatabaseSync): DailyResultsMismatch[] {
  const fromResults = `
    SELECT monitor_id, checked_at / ${DAY_MS} AS day,
      sum(${contribution('r').total}) AS t, sum(${contribution('r').up}) AS u, sum(${contribution('r').maintenance}) AS m,
      sum(${contribution('r').responseSum}) AS rs, sum(${contribution('r').responseCount}) AS rc
    FROM monitor_results r WHERE monitor_id IN (SELECT id FROM monitors) GROUP BY monitor_id, checked_at / ${DAY_MS}`
  const fromTable = `
    SELECT monitor_id, day, checks_total AS t, checks_up AS u, maintenance_checks AS m, response_sum AS rs, response_count AS rc
    FROM monitor_daily_results WHERE checks_total + maintenance_checks > 0`
  return sqlite.prepare(`
    SELECT 'results-only' AS side, monitor_id AS monitorId, day FROM (SELECT * FROM (${fromResults}) EXCEPT SELECT * FROM (${fromTable}))
    UNION ALL
    SELECT 'rollup-only', monitor_id, day FROM (SELECT * FROM (${fromTable}) EXCEPT SELECT * FROM (${fromResults}))
    ORDER BY 2, 3`).all() as unknown as DailyResultsMismatch[]
}
