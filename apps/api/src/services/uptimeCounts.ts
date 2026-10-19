import { sql } from 'drizzle-orm'
import { monitorResults } from '../db/schema.js'
import { RESULT_IN_MAINTENANCE } from '../db/resultMarks.js'

/**
 * Uptime is counted in SQL from these two sums. A failure inside a maintenance window is left out of both;
 * a failure not yet confirmed by the failure threshold is in the total but counts as up.
 */
export const countedChecks = sql<number>`sum(case when ${monitorResults.unconfirmed} = ${RESULT_IN_MAINTENANCE} then 0 else 1 end)`
/** Failed checks left out of the two sums above because they happened inside a maintenance window. */
export const maintenanceChecks = sql<number>`sum(case when ${monitorResults.unconfirmed} = ${RESULT_IN_MAINTENANCE} then 1 else 0 end)`
export const countedUp = sql<number>`sum(case when ${monitorResults.unconfirmed} = ${RESULT_IN_MAINTENANCE} then 0 when ${monitorResults.status} = 'up' or ${monitorResults.unconfirmed} = 1 then 1 else 0 end)`
