import { formatDateTime } from '@better-kit/ui'
import type { MaintenanceRecurrence } from '@bsp/shared'

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Monday first, as the week is read in most of the world.
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

export function describeRecurrence(win: { recurrence: MaintenanceRecurrence; recurrenceDays: number[]; timezone: string; recurrenceUntil: number | null }) {
  const until = win.recurrenceUntil === null ? '' : ` until ${formatDateTime(win.recurrenceUntil)}`
  const kind = win.recurrence === 'daily'
    ? 'Every day'
    : `Every ${WEEKDAY_ORDER.filter((day) => win.recurrenceDays.includes(day)).map((day) => WEEKDAY_LABELS[day]).join(', ')}`
  return `${kind} · ${win.timezone}${until}`
}
