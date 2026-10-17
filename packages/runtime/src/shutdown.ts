export interface ShutdownSteps {
  /** Stops producing new work and ends long-lived streams (SSE) so the server can drain. */
  stopIntake: () => void
  /** Stops accepting connections and resolves once in-flight requests have finished. */
  closeServer: () => Promise<void>
  /** Closes the DB and releases the app lock — only safe once no request can still use them. */
  releaseResources: () => void
  exit: (code: number) => void
  forceExitMs?: number
}

export interface RuntimeShutdown {
  /** Immediate full teardown, for paths where the server never started or has already closed. */
  cleanup: () => void
  /** Signal handler: drain the server first, then release shared resources and exit. */
  shutdown: () => void
}

export function createRuntimeShutdown(steps: ShutdownSteps): RuntimeShutdown {
  let intakeStopped = false
  let released = false
  let shuttingDown = false
  let forceExit: ReturnType<typeof setTimeout> | undefined
  const stopIntake = () => {
    if (intakeStopped) return
    intakeStopped = true
    steps.stopIntake()
  }
  const release = () => {
    if (released) return
    released = true
    steps.releaseResources()
  }
  const cleanup = () => {
    stopIntake()
    release()
  }
  const finish = (code: number) => {
    clearTimeout(forceExit)
    release()
    steps.exit(code)
  }

  return {
    cleanup,
    shutdown: () => {
      if (shuttingDown) return
      shuttingDown = true
      forceExit = setTimeout(() => {
        release()
        steps.exit(1)
      }, steps.forceExitMs ?? 5_000)
      forceExit.unref()
      stopIntake()
      steps.closeServer().then(() => finish(0), () => finish(1))
    },
  }
}
