import { beforeEach, describe, expect, it } from 'vitest'
import { formatClock, formatDate, formatDateTime, formatDayMonth, getDatePrefs, setDatePrefs } from './dateFormat'

// 9 Oct 2026 15:04:05 local time
const at = new Date(2026, 9, 9, 15, 4, 5).getTime()

describe('dateFormat', () => {
  beforeEach(() => setDatePrefs({ date: 'dmy', time: '24h' }))

  it('defaults to dd.mm.yyyy and 24-hour time', () => {
    expect(formatDate(at)).toBe('09.10.2026')
    expect(formatDayMonth(at)).toBe('09.10')
    expect(formatClock(at)).toBe('15:04')
    expect(formatDateTime(at, true)).toBe('09.10.2026 15:04:05')
  })

  it('supports the other date formats', () => {
    setDatePrefs({ date: 'dmyDash', time: '24h' })
    expect(formatDate(at)).toBe('09-10-2026')
    expect(formatDayMonth(at)).toBe('09-10')
    setDatePrefs({ date: 'ymdDot', time: '24h' })
    expect(formatDate(at)).toBe('2026.10.09')
    setDatePrefs({ date: 'mdy', time: '24h' })
    expect(formatDate(at)).toBe('10/09/2026')
    expect(formatDayMonth(at)).toBe('10/09')
    setDatePrefs({ date: 'ymd', time: '24h' })
    expect(formatDate(at)).toBe('2026-10-09')
  })

  it('supports 12-hour time', () => {
    setDatePrefs({ date: 'dmy', time: '12h' })
    expect(formatClock(at)).toBe('3:04 PM')
    expect(formatClock(new Date(2026, 9, 9, 0, 7).getTime())).toBe('12:07 AM')
  })

  it('formats the UTC day when asked', () => {
    expect(formatDate(Date.UTC(2026, 9, 9, 23, 30), true)).toBe('09.10.2026')
  })

  it('persists the choice per browser', () => {
    setDatePrefs({ date: 'ymd', time: '12h' })
    expect(JSON.parse(localStorage.getItem('bsp-date-format')!)).toEqual({ date: 'ymd', time: '12h' })
    expect(getDatePrefs()).toEqual({ date: 'ymd', time: '12h' })
  })
})
