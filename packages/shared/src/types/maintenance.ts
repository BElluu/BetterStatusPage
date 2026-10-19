export type MaintenanceRecurrence = 'none' | 'daily' | 'weekly'

/** A running window as the public status page gets it; times are those of the running occurrence. */
export interface PublicMaintenanceWindow {
  id: number
  name: string
  description: string | null
  startsAt: number
  endsAt: number
  /** Published monitors the window covers. Empty = every monitor. */
  monitorIds: number[]
}

export interface MaintenanceWindow {
  id: number
  name: string
  /**
   * Start of the first occurrence (unix ms). For a repeating window it also gives the time of day and the earliest
   * date; a weekly window runs first on the first chosen weekday on or after it.
   */
  startsAt: number
  /** End of the first occurrence (unix ms); its distance from startsAt is the length of every occurrence. */
  endsAt: number
  description: string | null
  /** How the window repeats after its first occurrence. */
  recurrence: MaintenanceRecurrence
  /** Weekdays a `weekly` window runs on, 0 = Sunday. Empty for the other kinds. */
  recurrenceDays: number[]
  /** IANA timezone the start time of a recurring window is read in. */
  timezone: string
  /** Last instant a recurring window may start (unix ms); null = repeats without end. */
  recurrenceUntil: number | null
  /** The occurrence shown to readers: the running one, else the next, else the window's own span. */
  occurrence: { startsAt: number; endsAt: number }
  /** Monitor IDs in maintenance. Empty array = all monitors. */
  monitorIds: number[]
  createdAt: number
  updatedAt: number
}
