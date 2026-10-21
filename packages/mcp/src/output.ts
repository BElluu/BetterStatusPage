/** Text that came from outside the instance (a monitored system, a visitor, an import) must reach an agent as plain data. */
const MAX_TEXT_LENGTH = 2000
const MAX_DEPTH = 12
const MAX_OUTPUT_BYTES = 64 * 1024

/** An escape sequence that sets colours or moves the cursor. */
const ANSI = new RegExp(String.raw`${String.fromCharCode(27)}\[[0-9;?]*[ -/]*[@-~]`, 'g')

/**
 * Control characters (tab and line breaks stay), bidi controls, zero-width characters, the byte order mark, variation
 * selectors, fillers and the Unicode tag characters, which people cannot see but a model reads.
 */
const INVISIBLE: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f],
  [0x00ad, 0x00ad], [0x061c, 0x061c], [0x115f, 0x1160], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0x3164, 0x3164],
  [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
]

const isInvisible = (code: number): boolean => INVISIBLE.some(([from, to]) => code >= from && code <= to)

export function cleanText(value: string): string {
  const clean = Array.from(value.replace(ANSI, '')).filter((char) => !isInvisible(char.codePointAt(0)!)).join('')
  return clean.length > MAX_TEXT_LENGTH ? `${clean.slice(0, MAX_TEXT_LENGTH)}…` : clean
}

/** Every string in a result, cleaned. */
export function cleanDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return cleanText(value)
  if (value === null || typeof value !== 'object') return value
  // Nothing below the limit is passed on unchecked.
  if (depth >= MAX_DEPTH) return '[nested too deep]'
  if (Array.isArray(value)) return value.map((each) => cleanDeep(each, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([key, each]) => [cleanText(key), cleanDeep(each, depth + 1)]))
}

/** A failure the agent should read as the tool's answer rather than as a crash. */
export class McpToolError extends Error {}

/** A tool result as text. A list under `items` is shortened until it fits; anything else that is too large is refused. */
export function boundedJson(data: unknown): string {
  const text = JSON.stringify(data)
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return text
  const holder = data as { items?: unknown[] } | null
  if (holder && typeof holder === 'object' && Array.isArray(holder.items)) {
    let keep = holder.items.length
    while (keep > 0) {
      keep = Math.floor(keep / 2)
      const shortened = JSON.stringify({ ...holder, items: holder.items.slice(0, keep), truncated: true, returnedItems: keep })
      if (Buffer.byteLength(shortened) <= MAX_OUTPUT_BYTES) return shortened
    }
  }
  throw new McpToolError('The result is too large to return. Narrow the query (a shorter period, a smaller limit, a filter).')
}
