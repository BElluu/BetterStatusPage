import { ENTITY_KEY_PATTERN } from '@better-kit/config-as-code'

/** The key as the monitor will carry it: lower case, anything else that a key may not hold becomes `-`. Null when no valid key results. */
export function normalizeHeartbeatKey(raw: string): string | null {
  const key = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  return ENTITY_KEY_PATTERN.test(key) ? key : null
}
