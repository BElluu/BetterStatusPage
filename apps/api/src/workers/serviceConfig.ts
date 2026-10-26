import { MAIL_PROTOCOLS, MAIL_SECURITY_MODES, MAX_EXPIRY_WARN_DAYS } from '@bsp/shared'
import type { MonitorType } from '@bsp/shared'
import { normalizeDomain } from './domainExpiry.js'

const MAX_HOST_LENGTH = 253
const MAX_TLS_CA_LENGTH = 64 * 1024
const MAX_TEXT_LENGTH = 1024

type Config = Record<string, unknown>

const host = (c: Config): string | null =>
  typeof c['host'] === 'string' && c['host'].trim() && c['host'].length <= MAX_HOST_LENGTH && !/\s/.test(c['host'])
    ? null
    : 'host is required and must not contain spaces'

const port = (c: Config): string | null =>
  Number.isInteger(c['port']) && (c['port'] as number) >= 1 && (c['port'] as number) <= 65_535 ? null : 'port must be a whole number from 1 to 65535'

const optionalText = (c: Config, key: string, max = MAX_TEXT_LENGTH): string | null =>
  c[key] === undefined || (typeof c[key] === 'string' && (c[key] as string).length <= max) ? null : `${key} must be text of at most ${max} characters`

const optionalFlag = (c: Config, key: string): string | null =>
  c[key] === undefined || typeof c[key] === 'boolean' ? null : `${key} must be true or false`

const warnDays = (c: Config): string | null =>
  Number.isInteger(c['warnDays']) && (c['warnDays'] as number) >= 1 && (c['warnDays'] as number) <= MAX_EXPIRY_WARN_DAYS
    ? null
    : `warnDays must be a whole number from 1 to ${MAX_EXPIRY_WARN_DAYS}`

const tlsSettings = (c: Config): string | null =>
  optionalFlag(c, 'verifyTls') ?? optionalText(c, 'tlsCa', MAX_TLS_CA_LENGTH)

const first = (...problems: (string | null)[]): string | null => problems.find((p) => p !== null) ?? null

/** What is wrong with the configuration of a redis, mail, ssh, tls or domain monitor, or null. Other types are not judged here. */
export function validateServiceConfig(type: MonitorType, c: Config): string | null {
  switch (type) {
    case 'redis':
      return first(host(c), port(c), optionalFlag(c, 'tls'), tlsSettings(c), optionalText(c, 'username'), optionalText(c, 'password'))
    case 'mail':
      return first(
        MAIL_PROTOCOLS.includes(c['protocol'] as never) ? null : `protocol must be one of: ${MAIL_PROTOCOLS.join(', ')}`,
        MAIL_SECURITY_MODES.includes(c['security'] as never) ? null : `security must be one of: ${MAIL_SECURITY_MODES.join(', ')}`,
        host(c), port(c), tlsSettings(c), optionalText(c, 'username'), optionalText(c, 'password'),
      )
    case 'ssh':
      return first(host(c), port(c), optionalText(c, 'expectedBanner', 255))
    case 'tls':
      return first(host(c), port(c), warnDays(c), tlsSettings(c), optionalText(c, 'servername', MAX_HOST_LENGTH))
    case 'domain':
      return first(
        typeof c['domain'] === 'string' && normalizeDomain(c['domain']) ? null : 'domain must be a registered domain name such as example.com',
        warnDays(c),
      )
    default:
      return null
  }
}
