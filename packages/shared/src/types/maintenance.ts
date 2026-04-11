export interface MaintenanceWindow {
  id: number
  name: string
  startsAt: number    // unix ms
  endsAt: number      // unix ms
  description: string | null
  /** Monitor IDs in maintenance. Empty array = all monitors. */
  monitorIds: number[]
  createdAt: number
  updatedAt: number
}
