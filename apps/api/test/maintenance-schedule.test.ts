import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { closeDb } from '../src/db/client.js'
import { db } from '../src/db/client.js'
import { maintenanceWindows } from '../src/db/schema.js'
import { activeWindows, liveWindows, maxOccurrenceMs, windowOccurrences, type ScheduledWindow } from '../src/services/maintenanceSchedule.js'
import { createTestDb, initTestDb, teardownTestDb, type TestDb } from './helpers/testDb.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
// Monday 2026-01-05 01:00 UTC, one hour long.
const FIRST = Date.UTC(2026, 0, 5, 1)

function win(overrides: Partial<ScheduledWindow> = {}): ScheduledWindow {
  return { startsAt: FIRST, endsAt: FIRST + HOUR, recurrence: 'daily', recurrenceDays: null, timezone: 'UTC', recurrenceUntil: null,
    endedEarlyStart: null, endedEarlyAt: null, ...overrides }
}

describe('windowOccurrences', () => {
  it('keeps a one-off window to its own span', () => {
    const once = win({ recurrence: 'none' })
    assert.deepEqual(windowOccurrences(once, FIRST + 1).current, { startsAt: FIRST, endsAt: FIRST + HOUR })
    assert.equal(windowOccurrences(once, FIRST + DAY).current, null)
    assert.equal(windowOccurrences(once, FIRST + DAY).next, null)
    assert.deepEqual(windowOccurrences(once, FIRST - 1).next, { startsAt: FIRST, endsAt: FIRST + HOUR })
  })

  it('repeats a daily window', () => {
    const later = FIRST + 10 * DAY
    assert.deepEqual(windowOccurrences(win(), later + 30 * 60_000).current, { startsAt: later, endsAt: later + HOUR })
    const between = windowOccurrences(win(), later + 5 * HOUR)
    assert.equal(between.current, null)
    assert.equal(between.next?.startsAt, later + DAY)
  })

  it('does not run before the first occurrence', () => {
    assert.equal(windowOccurrences(win(), FIRST - DAY + 30 * 60_000).current, null)
  })

  it('runs a weekly window only on the chosen weekdays', () => {
    const tuesdayAndThursday = win({ recurrence: 'weekly', recurrenceDays: '2,4' })
    assert.equal(windowOccurrences(tuesdayAndThursday, FIRST + 30 * 60_000).current, null)
    assert.equal(windowOccurrences(tuesdayAndThursday, FIRST + DAY + 30 * 60_000).current?.startsAt, FIRST + DAY)
    assert.equal(windowOccurrences(tuesdayAndThursday, FIRST + 2 * DAY + 30 * 60_000).current, null)
    assert.equal(windowOccurrences(tuesdayAndThursday, FIRST + 3 * DAY + 30 * 60_000).current?.startsAt, FIRST + 3 * DAY)
    assert.equal(windowOccurrences(tuesdayAndThursday, FIRST + 4 * DAY).next?.startsAt, FIRST + 8 * DAY)
  })

  it('stops after recurrenceUntil', () => {
    const limited = win({ recurrenceUntil: FIRST + 2 * DAY })
    assert.ok(windowOccurrences(limited, FIRST + 2 * DAY + 1).current)
    assert.equal(windowOccurrences(limited, FIRST + 3 * DAY + 1).current, null)
    assert.equal(windowOccurrences(limited, FIRST + 3 * DAY + 1).next, null)
  })

  it('reads the start time in the window timezone across a DST change', () => {
    // 02:00 Warsaw: 01:00 UTC in winter, 00:00 UTC after 2026-03-29.
    const start = Date.UTC(2026, 0, 5, 1)
    const warsaw = win({ startsAt: start, endsAt: start + HOUR, timezone: 'Europe/Warsaw' })
    const summer = Date.UTC(2026, 6, 1, 0, 30)
    assert.deepEqual(windowOccurrences(warsaw, summer).current, { startsAt: Date.UTC(2026, 6, 1, 0), endsAt: Date.UTC(2026, 6, 1, 1) })
  })

  it('stops only the occurrence that was ended early', () => {
    const day = FIRST + 10 * DAY
    const ended = win({ endedEarlyStart: day, endedEarlyAt: day + 20 * 60_000 })
    assert.equal(windowOccurrences(ended, day + 10 * 60_000).current?.endsAt, day + 20 * 60_000)
    assert.equal(windowOccurrences(ended, day + 30 * 60_000).current, null)
    assert.equal(windowOccurrences(ended, day + 30 * 60_000).next?.startsAt, day + DAY)
    assert.ok(windowOccurrences(ended, day + DAY + 30 * 60_000).current)
  })

  it('carries a window across midnight', () => {
    const start = Date.UTC(2026, 0, 5, 23)
    const overnight = win({ startsAt: start, endsAt: start + 2 * HOUR })
    const later = start + 4 * DAY
    assert.equal(windowOccurrences(overnight, later + 90 * 60_000).current?.startsAt, later)
  })
})

/** Minutes since local midnight in Warsaw, read independently of the code under test. */
function warsawMinutes(at: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
  return Number(parts.find((p) => p.type === 'hour')!.value) * 60 + Number(parts.find((p) => p.type === 'minute')!.value)
}

describe('days when the clocks change', () => {
  // Europe/Warsaw: clocks go forward on 2027-03-28 and back on 2027-10-31.
  const FIVE_MINUTES = 5 * 60_000
  const sweep = (from: number, to: number, check: (at: number) => void) => { for (let at = from; at < to; at += FIVE_MINUTES) check(at) }

  for (const [label, from, to] of [
    ['spring', Date.UTC(2027, 2, 26), Date.UTC(2027, 2, 31)],
    ['autumn', Date.UTC(2027, 9, 29), Date.UTC(2027, 10, 3)],
  ] as const) {
    it(`runs a daily 00:30-01:30 window every local night in ${label}`, () => {
      const start = Date.UTC(2027, 0, 5, 23, 30) // 00:30 on 6 January in Warsaw
      const nightly = win({ startsAt: start, endsAt: start + HOUR, timezone: 'Europe/Warsaw' })
      sweep(from, to, (at) => {
        const minutes = warsawMinutes(at)
        if (minutes > 30 && minutes < 90) assert.ok(windowOccurrences(nightly, at).current, new Date(at).toISOString())
        if (minutes > 95 || minutes < 25) assert.equal(windowOccurrences(nightly, at).current, null, new Date(at).toISOString())
      })
    })

    it(`runs a daily 23:30-23:50 window every local evening in ${label}`, () => {
      const start = Date.UTC(2027, 0, 5, 22, 30) // 23:30 on 5 January in Warsaw
      const evening = win({ startsAt: start, endsAt: start + 20 * 60_000, timezone: 'Europe/Warsaw' })
      sweep(from, to, (at) => {
        const minutes = warsawMinutes(at)
        if (minutes > 1411 && minutes < 1429) assert.ok(windowOccurrences(evening, at).current, new Date(at).toISOString())
        if (minutes < 1405 || minutes > 1435) assert.equal(windowOccurrences(evening, at).current, null, new Date(at).toISOString())
      })
    })
  }

  it('finds the next evening occurrence on the day before the clocks go forward', () => {
    const start = Date.UTC(2027, 0, 5, 22, 30)
    const evening = win({ startsAt: start, endsAt: start + 20 * 60_000, timezone: 'Europe/Warsaw' })
    // Saturday 27 March 23:55 and Sunday 28 March 01:30 local: the next one is Sunday 23:30 CEST = 21:30 UTC.
    for (const at of [Date.UTC(2027, 2, 27, 22, 55), Date.UTC(2027, 2, 28, 0, 30)]) {
      assert.equal(windowOccurrences(evening, at).next?.startsAt, Date.UTC(2027, 2, 28, 21, 30))
    }
  })

  it('keeps a weekly Sunday window on Sundays only across the change', () => {
    const start = Date.UTC(2027, 0, 9, 23, 30) // Sunday 10 January 00:30 in Warsaw
    const sundays = win({ startsAt: start, endsAt: start + HOUR, recurrence: 'weekly', recurrenceDays: '0', timezone: 'Europe/Warsaw' })
    const sunday = windowOccurrences(sundays, Date.UTC(2027, 2, 27, 23, 45)).current
    assert.equal(sunday?.startsAt, Date.UTC(2027, 2, 27, 23, 30))
    assert.equal(windowOccurrences(sundays, Date.UTC(2027, 2, 28, 23, 45)).current, null)
    assert.equal(windowOccurrences(sundays, Date.UTC(2027, 2, 29)).next?.startsAt, Date.UTC(2027, 3, 3, 22, 30))
  })

  it('resolves the same start instant whenever it is asked', () => {
    const start = Date.UTC(2027, 0, 5, 23, 30)
    const nightly = win({ startsAt: start, endsAt: start + HOUR, timezone: 'Europe/Warsaw' })
    const starts = new Set<number>()
    for (let at = Date.UTC(2027, 2, 27, 23, 31); at < Date.UTC(2027, 2, 28, 0, 29); at += FIVE_MINUTES) {
      starts.add(windowOccurrences(nightly, at).current!.startsAt)
    }
    assert.equal(starts.size, 1)
  })
})

describe('a series that has not started yet', () => {
  const NOW = Date.UTC(2026, 0, 5, 12) // Monday
  const ahead = NOW + 30 * DAY

  it('has no running occurrence and starts with the window itself', () => {
    const daily = win({ startsAt: ahead, endsAt: ahead + HOUR })
    const { current, next } = windowOccurrences(daily, NOW)
    assert.equal(current, null)
    assert.deepEqual(next, { startsAt: ahead, endsAt: ahead + HOUR })
  })

  it('waits for a chosen weekday when the weekday of the window itself is not one', () => {
    // The window starts on a Wednesday (ahead is 4 February 2026); Tuesday and Thursday are chosen.
    assert.equal(new Date(ahead).getUTCDay(), 3)
    const weekly = win({ startsAt: ahead, endsAt: ahead + HOUR, recurrence: 'weekly', recurrenceDays: '2,4' })
    assert.equal(windowOccurrences(weekly, NOW).next?.startsAt, ahead + DAY)
  })

  it('stops looking after the running occurrence when only that is asked for', () => {
    const daily = win()
    assert.equal(windowOccurrences(daily, FIRST + 10 * DAY + 5 * HOUR, true).next, null)
    assert.ok(windowOccurrences(daily, FIRST + 10 * DAY + 5 * HOUR).next)
    assert.ok(windowOccurrences(daily, FIRST + 10 * DAY + 30 * 60_000, true).current)
  })
})

describe('repeated hour and shortened day', () => {
  it('takes the stored instant of the window itself when its local time happens twice', () => {
    // New York, 7 November 2027: 01:30 occurs as EDT (05:30Z) and again as EST (06:30Z). The window was made on the second.
    const second = Date.UTC(2027, 10, 7, 6, 30)
    const repeated = win({ startsAt: second, endsAt: second + 30 * 60_000, timezone: 'America/New_York' })
    assert.equal(windowOccurrences(repeated, second + 10 * 60_000).current?.startsAt, second)
  })

  it('lets a longest allowed window end before the next one on the day the clocks go forward', () => {
    // Warsaw, daily 00:00 for 23 hours; 28 March 2027 starts at 00:00 CET (23:00Z) and lasts to 22:00Z, when the 29th starts.
    const start = Date.UTC(2027, 0, 5, 23)
    const nightly = win({ startsAt: start, endsAt: start + maxOccurrenceMs('daily', []), timezone: 'Europe/Warsaw' })
    const twentyEighth = Date.UTC(2027, 2, 27, 23)
    const twentyNinth = Date.UTC(2027, 2, 28, 22)
    assert.equal(windowOccurrences(nightly, twentyNinth - 60_000).current?.startsAt, twentyEighth)
    assert.equal(windowOccurrences(nightly, twentyNinth + 30 * 60_000).current?.startsAt, twentyNinth)
    // Ending the 29th early stops the window: the 28th is already over.
    const ended = { ...nightly, endedEarlyStart: twentyNinth, endedEarlyAt: twentyNinth + 20 * 60_000 }
    assert.equal(windowOccurrences(ended, twentyNinth + 30 * 60_000).current, null)
  })
})

describe('an early end', () => {
  it('still holds after the window was moved to start earlier at the same time of day', () => {
    const day = FIRST + 10 * DAY
    const ended = { endedEarlyStart: day, endedEarlyAt: day + 20 * 60_000 }
    const original = win(ended)
    const movedBack = win({ ...ended, startsAt: FIRST - 3 * DAY, endsAt: FIRST - 3 * DAY + HOUR })
    for (const w of [original, movedBack]) {
      assert.equal(windowOccurrences(w, day + 30 * 60_000).current, null)
      assert.equal(windowOccurrences(w, day + 10 * 60_000).current?.endsAt, day + 20 * 60_000)
    }
  })
})

describe('longest occurrence', () => {
  it('is a day for daily windows and the shortest gap between weekdays for weekly ones', () => {
    // An hour less, so it also holds on a local day of 23 hours.
    assert.equal(maxOccurrenceMs('daily', []), DAY - HOUR)
    assert.equal(maxOccurrenceMs('weekly', [2]), 7 * DAY - HOUR)
    assert.equal(maxOccurrenceMs('weekly', [1, 2, 5]), DAY - HOUR)
    assert.equal(maxOccurrenceMs('weekly', [6, 0]), DAY - HOUR)
    assert.equal(maxOccurrenceMs('weekly', [1, 4]), 3 * DAY - HOUR)
    assert.equal(maxOccurrenceMs('none', []), Infinity)
  })
})

describe('live windows', () => {
  let testDb: TestDb
  before(() => {
    testDb = createTestDb('bsp-maintenance-schedule-')
    closeDb()
    initTestDb()
  })
  after(() => teardownTestDb(testDb))

  it('lists a series that starts later as live but not as active, and drops one past its last start', async () => {
    const now = FIRST + 10 * DAY + 30 * 60_000
    const base = { createdAt: now, updatedAt: now, recurrence: 'daily' }
    await db.insert(maintenanceWindows).values([
      { name: 'later series', startsAt: now + 30 * DAY, endsAt: now + 30 * DAY + HOUR, ...base },
      { name: 'finished series', startsAt: FIRST, endsAt: FIRST + HOUR, recurrenceUntil: FIRST + 2 * DAY, ...base },
    ])
    assert.ok((await liveWindows(now)).some((w) => w.name === 'later series'))
    assert.ok(!(await activeWindows(now)).some((w) => w.name === 'later series'))
    assert.ok(!(await liveWindows(now)).some((w) => w.name === 'finished series'))
    assert.ok(!(await activeWindows(now)).some((w) => w.name === 'finished series'))
  })

  it('shows the running occurrence of a recurring window and skips a finished one-off', async () => {
    const now = FIRST + 10 * DAY + 30 * 60_000
    const base = { createdAt: now, updatedAt: now }
    await db.insert(maintenanceWindows).values([
      { name: 'nightly', startsAt: FIRST, endsAt: FIRST + HOUR, recurrence: 'daily', ...base },
      { name: 'old', startsAt: FIRST, endsAt: FIRST + HOUR, ...base },
    ])
    const live = await liveWindows(now)
    assert.deepEqual(live.map((w) => w.name).filter((name) => name === 'nightly' || name === 'old'), ['nightly'])
    const [running] = await activeWindows(now)
    assert.equal(running?.startsAt, FIRST + 10 * DAY)
    assert.equal(running?.endsAt, FIRST + 10 * DAY + HOUR)
  })
})
