/** Shortens text that comes from a request before it is repeated in an answer, so an error cannot be made to echo a megabyte. */
export function clip(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** Whether `value` nests objects or lists deeper than `max` levels. Checked without recursion, so it cannot overflow the stack. */
export function nestedDeeperThan(value: unknown, max: number): boolean {
  const pending: Array<[unknown, number]> = [[value, 0]]
  while (pending.length) {
    const [current, depth] = pending.pop()!
    if (!current || typeof current !== 'object') continue
    if (depth >= max) return true
    for (const inner of Object.values(current)) pending.push([inner, depth + 1])
  }
  return false
}
