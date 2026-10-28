import { MAX_JSON_ASSERTION_BODY_BYTES } from '@bsp/shared'
import type { AssertionFailureStatus, HttpAssertion, HttpsConfig } from '@bsp/shared'
import { firstProblem, HTTPS_CHECKS_SCHEMA } from '../services/monitorConfigSchema.js'
import { isNumeric, needsValue, parseJsonPath, type Segment } from './assertionRules.js'

export { parseJsonPath } from './assertionRules.js'

const MAX_SHOWN_LENGTH = 80
/** Headers whose value is a credential; a failed assertion names them but never shows what they held. */
const SENSITIVE_HEADERS = new Set(['set-cookie', 'cookie', 'authorization', 'proxy-authorization'])

/** The value at the path, or undefined when any step is missing. A JSON null is a value. */
function resolvePath(root: unknown, segments: Segment[]): unknown {
  let current: unknown = root
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) return undefined
      current = current[segment]
    } else {
      if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
      if (!Object.hasOwn(current, segment)) return undefined
      current = (current as Record<string, unknown>)[segment]
    }
  }
  return current
}

/** Returns a message for the first problem in the assertions or the slow-response threshold, else null. */
export function validateHttpAssertions(config: Partial<HttpsConfig>): string | null {
  return firstProblem(HTTPS_CHECKS_SCHEMA, config)
}

export interface AssertionOutcome {
  ok: boolean
  /** What was checked, e.g. `Header "X-Replicas" equals "2"`. */
  label: string
  /** Why it failed; absent when it passed. */
  detail?: string
  onFail: AssertionFailureStatus
}

const OP_WORDS: Record<string, string> = {
  exists: 'exists',
  'not-exists': 'is absent',
  equals: 'equals',
  'not-equals': 'does not equal',
  contains: 'contains',
  lt: 'is less than',
  gt: 'is greater than',
}

const quote = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  return typeof value === 'string' ? `"${text.length > MAX_SHOWN_LENGTH ? `${text.slice(0, MAX_SHOWN_LENGTH)}…` : text}"` : text.slice(0, MAX_SHOWN_LENGTH)
}

export function describeAssertion(a: HttpAssertion): string {
  const subject = a.type === 'header' ? `Header "${a.name}"` : a.path
  const verb = OP_WORDS[a.op] ?? a.op
  return needsValue(a.op) ? `${subject} ${verb} ${quote(a.value)}` : `${subject} ${verb}`
}

function compare(op: HttpAssertion['op'], actual: unknown, expected: string | number | undefined): boolean {
  switch (op) {
    case 'exists': return actual !== undefined
    case 'not-exists': return actual === undefined
    case 'equals': return actual !== undefined && typeof actual !== 'object' && String(actual) === String(expected)
    case 'not-equals': return actual === undefined || typeof actual === 'object' || String(actual) !== String(expected)
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(expected))
      return Array.isArray(actual) && actual.some((item) => typeof item !== 'object' && String(item) === String(expected))
    case 'lt': return isNumeric(actual) && Number(actual) < Number(expected)
    case 'gt': return isNumeric(actual) && Number(actual) > Number(expected)
    default: return false
  }
}

/**
 * What the response had at the checked place, for the failure message. The value is shown only when
 * the reader may see what the monitored endpoint answers: a failed assertion otherwise reads
 * whatever the URL points at back to whoever typed it.
 */
function describeActual(a: HttpAssertion, actual: unknown, showActual: boolean): string {
  if (actual === undefined) return a.type === 'header' ? 'the header is missing' : 'the field is missing'
  if (a.type === 'header' && SENSITIVE_HEADERS.has(a.name.toLowerCase())) return 'the header is present'
  return showActual ? `it is ${quote(actual)}` : 'the value is not shown'
}

/**
 * Checks every assertion against the final response. The body is read, once, only when a JSON
 * assertion needs it; a body that is too large or not JSON fails the JSON assertions instead of the check.
 */
export async function evaluateAssertions(
  assertions: HttpAssertion[],
  headers: { get(name: string): string | null },
  readBody: () => Promise<string>,
  { showActual = false }: { showActual?: boolean } = {},
): Promise<AssertionOutcome[]> {
  let json: { value: unknown } | { error: string } | undefined
  const parseBody = async (): Promise<{ value: unknown } | { error: string }> => {
    if (json) return json
    const declared = Number(headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_JSON_ASSERTION_BODY_BYTES) {
      return (json = { error: 'the response body is larger than 1 MB' })
    }
    const text = await readBody()
    if (Buffer.byteLength(text, 'utf8') > MAX_JSON_ASSERTION_BODY_BYTES) return (json = { error: 'the response body is larger than 1 MB' })
    try {
      return (json = { value: JSON.parse(text) })
    } catch {
      return (json = { error: 'the response body is not valid JSON' })
    }
  }

  const outcomes: AssertionOutcome[] = []
  for (const a of assertions) {
    const label = describeAssertion(a)
    const onFail = a.onFail ?? 'degraded'
    let actual: unknown
    if (a.type === 'header') {
      actual = headers.get(a.name) ?? undefined
    } else {
      const body = await parseBody()
      if ('error' in body) {
        outcomes.push({ ok: false, label, detail: `${label}: ${body.error}`, onFail })
        continue
      }
      actual = resolvePath(body.value, parseJsonPath(a.path) ?? [])
    }
    if (compare(a.op, actual, a.value)) {
      outcomes.push({ ok: true, label, onFail })
    } else {
      outcomes.push({ ok: false, label, detail: `${label} failed: ${describeActual(a, actual, showActual)}`, onFail })
    }
  }
  return outcomes
}

/** The worst status among the failed outcomes: any "down" wins over "degraded"; null when none failed. */
export function worstFailure(outcomes: AssertionOutcome[]): AssertionFailureStatus | null {
  const failed = outcomes.filter((o) => !o.ok)
  if (failed.length === 0) return null
  return failed.some((o) => o.onFail === 'down') ? 'down' : 'degraded'
}

export const hasJsonAssertions = (assertions: HttpAssertion[] | undefined): boolean =>
  assertions?.some((a) => a.type === 'json') ?? false
