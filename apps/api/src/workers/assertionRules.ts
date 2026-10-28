/** The rules of HTTP assertions that do not need to run one: what a header name and a JSON path may look like. */
export const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
export const MAX_VALUE_LENGTH = 1000
const MAX_PATH_LENGTH = 200

export type Segment = string | number

/**
 * Reads a JSONPath subset: `$`, then `.name`, `['name']` or `[index]` steps. Returns null when the
 * path is not in that subset.
 */
export function parseJsonPath(path: string): Segment[] | null {
  if (path.length > MAX_PATH_LENGTH || !path.startsWith('$')) return null
  const segments: Segment[] = []
  let i = 1
  while (i < path.length) {
    if (path[i] === '.') {
      const name = /^[A-Za-z0-9_$-]+/.exec(path.slice(i + 1))?.[0]
      if (!name) return null
      segments.push(name)
      i += 1 + name.length
    } else if (path[i] === '[') {
      const end = path.indexOf(']', i)
      if (end === -1) return null
      const inner = path.slice(i + 1, end)
      const quoted = /^'([^']*)'$/.exec(inner) ?? /^"([^"]*)"$/.exec(inner)
      if (quoted) segments.push(quoted[1] as string)
      else if (/^\d{1,9}$/.test(inner)) segments.push(Number(inner))
      else return null
      i = end + 1
    } else {
      return null
    }
  }
  return segments
}

/** Every operator but "exists" and "not-exists" compares with a value. */
export const needsValue = (op: string): boolean => op !== 'exists' && op !== 'not-exists'

export const isNumeric = (value: unknown): boolean =>
  (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
