import { createAlertPolicy, isValidTimezone, isWithinQuietHours, localMinutes, quietHoursEndAt } from '@better-kit/notify'
import type { ChannelAlertPolicy } from '@bsp/shared'

export { isValidTimezone, isWithinQuietHours, localMinutes, quietHoursEndAt }

// The grouping setting has always been stored and sent as `minMonitors`; the notify package calls it `minSources`.
const policy = createAlertPolicy({ minSourcesKey: 'minMonitors' })

/** Coerces untrusted input (API body or stored JSON) into a complete, in-range policy. */
export function normalizeAlertPolicy(input: unknown): ChannelAlertPolicy {
  return policy.toWire(policy.normalizeAlertPolicy(input)) as unknown as ChannelAlertPolicy
}

/** Reads a channel's stored `alert_policy` column, falling back to defaults on anything unusable. */
export function parseAlertPolicy(stored: string | null | undefined): ChannelAlertPolicy {
  return policy.toWire(policy.parseAlertPolicy(stored)) as unknown as ChannelAlertPolicy
}
