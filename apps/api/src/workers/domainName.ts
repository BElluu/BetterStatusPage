const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/

/** The domain as it is looked up (lower case, no trailing dot), or null when it is not a domain name. */
export function normalizeDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/\.$/, '')
  return DOMAIN_PATTERN.test(domain) ? domain : null
}
