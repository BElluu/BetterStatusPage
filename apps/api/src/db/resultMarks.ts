/** `monitor_results.unconfirmed`: a failure not (yet) confirmed by the failure threshold; it does not lower uptime. */
export const RESULT_UNCONFIRMED = 1
/** `monitor_results.unconfirmed`: a failure observed inside a maintenance window; it is left out of uptime. */
export const RESULT_IN_MAINTENANCE = 2
