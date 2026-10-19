export interface IntervalRunnerOptions {
  /** Read before every wait, so a changed setting applies without a restart. */
  intervalMs: () => number
  job: () => Promise<void>
}

/** Runs a job again `intervalMs` after the previous run ended, and never two at once. */
export function createIntervalRunner({ intervalMs, job }: IntervalRunnerOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let stopped = true

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => { void runNow() }, intervalMs())
    timer.unref()
  }

  /** Starts a run now unless one is going; resolves when the run in progress (new or not) ends. */
  function runNow(): Promise<void> {
    if (running) return running
    if (timer) clearTimeout(timer)
    running = job().catch(() => { /* the job reports its own failures */ }).finally(() => {
      running = null
      schedule()
    })
    return running
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      void runNow()
    },
    /**
     * Stops scheduling. A run in progress is waited for unless `wait` is false; it then ends on its own and schedules
     * nothing, unless the runner was started again meanwhile.
     */
    async stop({ wait = true }: { wait?: boolean } = {}) {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      if (wait) await running
    },
    runNow,
  }
}
