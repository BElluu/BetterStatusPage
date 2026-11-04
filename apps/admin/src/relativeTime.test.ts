import { describe, expect, it } from 'vitest'
import { formatAgo, formatSpan } from './relativeTime'

const NOW = Date.UTC(2026, 10, 3, 12)

describe('formatAgo', () => {
  it.each([
    [2_000, 'just now'],
    [12_000, '12 s ago'],
    [59_000, '59 s ago'],
    [60_000, '1 min ago'],
    [59 * 60_000, '59 min ago'],
    [3 * 3_600_000, '3 h ago'],
    [47 * 3_600_000, '47 h ago'],
    [3 * 86_400_000, '3 d ago'],
  ])('reads %i ms as "%s"', (ms, text) => {
    expect(formatAgo(NOW - ms, NOW)).toBe(text)
  })

  it('treats a moment in the future (a clock that is slightly off) as just now', () => {
    expect(formatAgo(NOW + 30_000, NOW)).toBe('just now')
  })
})

describe('formatSpan', () => {
  it.each([
    [10_000, '<1 min'],
    [14 * 60_000, '14 min'],
    [60 * 60_000, '1 h'],
    [125 * 60_000, '2 h 5 min'],
    [47 * 3_600_000, '47 h'],
    [72 * 3_600_000, '3 d'],
    [-5_000, '<1 min'],
  ])('reads %i ms as "%s"', (ms, text) => {
    expect(formatSpan(ms)).toBe(text)
  })
})
