import { z } from 'zod'
import {
  DATABASE_TLS_MODES, DEFAULT_CERT_WARN_DAYS, DEFAULT_EXPIRY_WARN_DAYS, HEADER_ASSERTION_OPS, JSON_ASSERTION_OPS, MAIL_DEFAULT_PORTS,
  MAIL_PROTOCOLS, MAIL_SECURITY_MODES, MAX_CERT_WARN_DAYS, MAX_DEGRADED_ABOVE_MS, MAX_EXPIRY_WARN_DAYS, MAX_HTTP_ASSERTIONS,
} from '@bsp/shared'
import type {
  DatabaseConfig, DnsConfig, DockerConfig, DomainConfig, HttpsConfig, MailConfig, MonitorType, PingConfig, RedisConfig,
  SshConfig, TlsCertConfig, WebhookConfig,
} from '@bsp/shared'
import { normalizeDomain } from '../workers/domainName.js'
import { CONTAINER_NAME, parseDockerEndpoint } from '../workers/dockerEndpoint.js'
import { HEADER_NAME, isNumeric, MAX_VALUE_LENGTH, needsValue, parseJsonPath } from '../workers/assertionRules.js'

/**
 * What a monitor's config may hold, one schema per type. This is the single place that says it: the API judges a
 * config with it (validateMonitorConfig) and an agent is told the same thing from it (monitor_config_fields reads
 * its JSON Schema), so the two cannot disagree.
 *
 * Two kinds of field, and the difference is visible to the agent:
 * - checked: a real zod schema. The API refuses a wrong value, and a field that is not optional is refused when missing.
 * - unchecked (`loose`): described, but the API accepts any value. Making one of these strict is a change of one line
 *   here, and a change of behaviour of the API, so it is a decision of its own.
 * Keywords added to the JSON Schema: `needed` (the check cannot work without it), `default` (what is used when absent),
 * `suggested` (what the admin console starts a new monitor with), `unchecked`, and `secret` / `secretPaths`.
 *
 * Messages are the ones the API has always answered with; the tests that pin them are the contract of a change here.
 */
type Meta = Record<string, unknown>
const MAX_HOST_LENGTH = 253
const MAX_TEXT_LENGTH = 1024
const MAX_TLS_CA_LENGTH = 64 * 1024
const MAX_ASSERTION_PATH = 200

const SECRET_NOTE = 'A person sets it in the admin console; do not ask for it in the chat.'

/** Described, not judged. */
const loose = (type: string, description: string, meta: Meta = {}) =>
  z.unknown().optional().meta({ type, description, unchecked: true, ...meta })
/** Described, not judged, and the check cannot work without it. */
const looseNeeded = (type: string, description: string, meta: Meta = {}) => loose(type, description, { needed: true, ...meta })

/**
 * Lengths are counted in UTF-16 units, as the API always has: zod's own max() counts code points, which would let twice
 * as many emoji through. So the bound is a check of our own, and the JSON Schema is told the same bound.
 */
const within = (max: number) => (value: string): boolean => value.length <= max

const HOST_MESSAGE = 'host is required and must not contain spaces'
const isHost = (value: unknown): boolean => typeof value === 'string' && value.length >= 1 && within(MAX_HOST_LENGTH)(value) && /^\S+$/.test(value)
const host = (description: string) =>
  z.string({ error: HOST_MESSAGE }).refine(isHost, { error: HOST_MESSAGE })
    .meta({ description, minLength: 1, maxLength: MAX_HOST_LENGTH, pattern: '^\\S+$' })

const HOSTNAME_MESSAGE = 'hostname is required and must not contain spaces'
const isPort = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535

const PORT_MESSAGE = 'port must be a whole number from 1 to 65535'
const port = (description: string, meta: Meta = {}) =>
  z.number({ error: PORT_MESSAGE }).int({ error: PORT_MESSAGE }).min(1, { error: PORT_MESSAGE }).max(65_535, { error: PORT_MESSAGE }).meta({ description, ...meta })

const WARN_DAYS_MESSAGE = `warnDays must be a whole number from 1 to ${MAX_EXPIRY_WARN_DAYS}`
const warnDays = (description: string, suggested: number) =>
  z.number({ error: WARN_DAYS_MESSAGE }).int({ error: WARN_DAYS_MESSAGE }).min(1, { error: WARN_DAYS_MESSAGE }).max(MAX_EXPIRY_WARN_DAYS, { error: WARN_DAYS_MESSAGE }).meta({ description, suggested })

const text = (key: string, max: number, description: string, meta: Meta = {}) => {
  const message = `${key} must be text of at most ${max} characters`
  return z.string({ error: message }).refine(within(max), { error: message }).optional().meta({ description, maxLength: max, ...meta })
}

const flag = (key: string, description: string, meta: Meta = {}) =>
  z.boolean({ error: `${key} must be true or false` }).optional().meta({ description, ...meta })

const socketTls = {
  verifyTls: flag('verifyTls', 'Checks the certificate chain and host name.', { default: true }),
  tlsCa: text('tlsCa', MAX_TLS_CA_LENGTH, 'PEM certificate(s) of the authority that signed the server certificate; empty uses the CAs bundled with Node.js.'),
}

const VAULT = loose('object', 'Reference to a vault secret that replaces the credentials. Needs the vault:use permission, which an agent token should not have: a person sets this in the admin console.')

// ── HTTPS ───────────────────────────────────────────────────────────────────

const URL_MESSAGE = 'url must be a full address starting with http:// or https://'
const URL_CREDENTIALS_MESSAGE = 'url must not contain a user name or password; use the sign-in settings'
const MAX_URL_LENGTH = 2048
/** The text itself must start with the scheme: code that reads the raw string (certificate and TLS options) relies on it. */
const isWebAddress = (value: string): boolean => {
  // No whitespace or control characters anywhere: URL parsing drops some of them, the rest of the code does not.
  if (!/^https?:\/\//i.test(value) || /\s/.test(value) || [...value].some((char) => char.charCodeAt(0) < 32) || value.length > MAX_URL_LENGTH) return false
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}
const hasCredentials = (value: string): boolean => {
  try { const url = new URL(value); return !!(url.username || url.password) } catch { return false }
}
const HTTP_METHODS = ['GET', 'POST', 'HEAD']
const METHOD_MESSAGE = `method must be one of: ${HTTP_METHODS.join(', ')}`
const STATUS_MESSAGE = 'expectedStatus must be a whole number from 200 to 599'

const DEGRADED_MESSAGE = `degradedAboveMs must be a whole number of milliseconds from 1 to ${MAX_DEGRADED_ABOVE_MS}`

/** What is wrong with one assertion, or null. `index` is its position, from 0. */
function assertionProblem(raw: unknown, index: number): string | null {
  const where = `Assertion ${index + 1}`
  if (typeof raw !== 'object' || raw === null) return `${where} must be an object`
  const a = raw as Record<string, unknown>
  if (a['onFail'] !== undefined && a['onFail'] !== 'degraded' && a['onFail'] !== 'down') return `${where}: onFail must be "degraded" or "down"`
  const ops: readonly string[] = a['type'] === 'header' ? HEADER_ASSERTION_OPS : JSON_ASSERTION_OPS
  if (a['type'] !== 'header' && a['type'] !== 'json') return `${where}: type must be "header" or "json"`
  if (typeof a['op'] !== 'string' || !ops.includes(a['op'])) return `${where}: op must be one of: ${ops.join(', ')}`
  if (a['type'] === 'header') {
    if (typeof a['name'] !== 'string' || !HEADER_NAME.test(a['name'])) return `${where}: name is not a valid header name`
  } else if (typeof a['path'] !== 'string' || !parseJsonPath(a['path'])) {
    return `${where}: path must look like $.field, $.list[0].field or $['field']`
  }
  if (needsValue(a['op'])) {
    const value = a['value']
    const typeOk = a['type'] === 'header' ? typeof value === 'string' : typeof value === 'string' || typeof value === 'number'
    if (!typeOk) return `${where}: value is required for "${a['op']}"`
    if (String(value).length > MAX_VALUE_LENGTH) return `${where}: value must be at most ${MAX_VALUE_LENGTH} characters`
    if ((a['op'] === 'lt' || a['op'] === 'gt') && !isNumeric(value)) return `${where}: value must be a number for "${a['op']}"`
  }
  return null
}

/** The shape of one assertion, for the agent. assertionProblem is what enforces it; the tests hold the two together. */
const ON_FAIL = { enum: ['degraded', 'down'], description: 'What a failed check turns the monitor into. Degraded when absent.' }
const ASSERTION_ITEM: Meta = {
  oneOf: [
    {
      type: 'object', description: 'A check on a response header.',
      properties: {
        type: { const: 'header' },
        name: { type: 'string', pattern: HEADER_NAME.source, description: 'Header name.' },
        op: { enum: [...HEADER_ASSERTION_OPS] },
        value: { type: 'string', maxLength: MAX_VALUE_LENGTH, description: 'Required unless op is exists or not-exists.' },
        onFail: ON_FAIL,
      },
      required: ['type', 'name', 'op'],
    },
    {
      type: 'object', description: 'A check on a field of a JSON response body (up to 1 MB).',
      properties: {
        type: { const: 'json' },
        path: { type: 'string', maxLength: MAX_ASSERTION_PATH, description: "Like $.queue.length, $.list[0].field or $['field']." },
        op: { enum: [...JSON_ASSERTION_OPS] },
        value: { type: ['string', 'number'], maxLength: MAX_VALUE_LENGTH, description: 'Required unless op is exists; a number for lt and gt.' },
        onFail: ON_FAIL,
      },
      required: ['type', 'path', 'op'],
    },
  ],
}

/** The checks on a response that were made for the Test button as well; exported separately for it. */
const httpsChecks = {
  degradedAboveMs: z.number({ error: DEGRADED_MESSAGE }).int({ error: DEGRADED_MESSAGE }).min(1, { error: DEGRADED_MESSAGE }).max(MAX_DEGRADED_ABOVE_MS, { error: DEGRADED_MESSAGE })
    .optional().meta({ description: 'A response slower than this many milliseconds makes the check Degraded.' }),
  assertions: z.array(z.unknown().meta(ASSERTION_ITEM), { error: 'assertions must be a list' })
    .max(MAX_HTTP_ASSERTIONS, { error: `At most ${MAX_HTTP_ASSERTIONS} assertions are allowed` })
    .superRefine((list, ctx) => {
      for (const [index, raw] of list.entries()) {
        const problem = assertionProblem(raw, index)
        if (problem) { ctx.addIssue({ code: 'custom', message: problem }); return }
      }
    })
    .optional().meta({ description: 'Checks on the final response (after redirects), each failing as Degraded or Down.' }),
}

const httpsShape = {
  url: z.string({ error: URL_MESSAGE }).refine(isWebAddress, { error: URL_MESSAGE }).refine((value) => !hasCredentials(value), { error: URL_CREDENTIALS_MESSAGE })
    .meta({ description: 'The address to request: a full address starting with http:// or https:// (only those, at most 2048 characters, no user name or password in it).', format: 'uri', pattern: '^[Hh][Tt][Tt][Pp][Ss]?://', maxLength: MAX_URL_LENGTH }),
  method: z.string({ error: METHOD_MESSAGE }).refine((value) => HTTP_METHODS.includes(value.toUpperCase()), { error: METHOD_MESSAGE })
    .optional().meta({ description: 'HTTP method. The monitor sends it to its address at every check.', enum: HTTP_METHODS, default: 'GET' }),
  expectedStatus: z.number({ error: STATUS_MESSAGE }).int({ error: STATUS_MESSAGE }).min(200, { error: STATUS_MESSAGE }).max(599, { error: STATUS_MESSAGE })
    .optional().meta({ description: 'The status code that counts as up: the final one, after redirects are followed.', default: 200 }),
  keyword: loose('string', 'Text that must appear in the response body.'),
  ...httpsChecks,
  headers: loose('object', `Request headers as { name: value }. Credential headers (Authorization and similar) are secrets. ${SECRET_NOTE}`),
  body: loose('string', 'Request body for POST.'),
  auth: loose('object', `Sign-in: { type: "none" } (default), or "basic" { basic: { username, password } }, "oauth2" { oauth2: { tokenUrl, clientId, clientSecret, scope? } }, "cas" { cas: { casServerUrl, username, password } }. Passwords and secrets: ${SECRET_NOTE}`),
  ignoreTls: flag('ignoreTls', 'Accepts any server certificate (self-signed, expired, wrong host). Disables certificate expiry warnings.', { default: false }),
  certExpiry: loose('object', `Warns before the TLS certificate expires: { enabled: boolean, warnDays: 1 to ${MAX_CERT_WARN_DAYS} }. The console starts at ${DEFAULT_CERT_WARN_DAYS} days.`),
  cacheBuster: flag('cacheBuster', 'Adds a random bsp_cachebuster query parameter to every request so a CDN or proxy cache cannot answer for a backend that is down. GET and HEAD only; not used with CAS. This is the "bypass cache" option.', { default: false }),
} satisfies { [Key in keyof Required<HttpsConfig>]: z.ZodType }

// ── Ping, DNS ───────────────────────────────────────────────────────────────

const DNS_RECORD_TYPES = ['A', 'AAAA', 'MX', 'CNAME', 'TXT'] as const

const pingShape = {
  host: host('Host name or IP address.'),
  mode: z.enum(['tcp', 'icmp'], { error: 'mode must be one of: tcp, icmp' }).optional()
    .meta({ description: 'tcp connects to a port; icmp sends a ping. Absent means tcp.', default: 'tcp' }),
  // Judged with the mode (see pingSchema): a port is only used by tcp.
  port: z.unknown().optional().meta({ type: 'integer', description: 'Port for tcp; not used by icmp.', default: 80, minimum: 1, maximum: 65_535 }),
} satisfies { [Key in keyof Required<PingConfig>]: z.ZodType }

const pingSchema = z.looseObject(pingShape)
  .superRefine((config, ctx) => {
    if (config.mode !== 'icmp' && config.port !== undefined && !isPort(config.port)) ctx.addIssue({ code: 'custom', message: PORT_MESSAGE, path: ['port'] })
  })

const dnsShape = {
  hostname: z.string({ error: HOSTNAME_MESSAGE }).refine(isHost, { error: HOSTNAME_MESSAGE }).meta({ description: 'The name to resolve.', minLength: 1, maxLength: MAX_HOST_LENGTH, pattern: '^\\S+$' }),
  recordType: z.enum(DNS_RECORD_TYPES, { error: `recordType must be one of: ${DNS_RECORD_TYPES.join(', ')}` }).optional()
    .meta({ description: 'Record type. Absent looks up A records.', default: 'A' }),
  expectedValue: loose('string', 'A value the answer must contain.'),
  resolver: loose('string', 'DNS server to ask instead of the system default.'),
} satisfies { [Key in keyof Required<DnsConfig>]: z.ZodType }

// ── Databases ───────────────────────────────────────────────────────────────

const databaseShape = {
  // Judged together with the mode (see databaseSchema): required in fields mode, not used with a connection string.
  host: z.unknown().optional().meta({ type: 'string', description: 'Database host. Required unless mode is connectionString.', minLength: 1, maxLength: MAX_HOST_LENGTH, pattern: '^\\S+$' }),
  port: z.unknown().optional().meta({ type: 'integer', description: 'Port. Absent means the usual one of the engine: SQL Server 1433, PostgreSQL 5432, MySQL 3306, MongoDB 27017, Oracle 1521.', minimum: 1, maximum: 65_535 }),
  database: looseNeeded('string', 'Database name (Oracle: service name).'),
  user: looseNeeded('string', 'User name (fields mode; not used with a connection string).'),
  password: loose('string', `Password. The monitor can be created without it; ${SECRET_NOTE}`),
  query: loose('string', 'SQL statement to run (MongoDB: a JSON command). Without one: SELECT 1 AS result (SQL Server, PostgreSQL, MySQL), {"ping":1} (MongoDB), SELECT 1 FROM DUAL (Oracle).'),
  expectedResult: loose('string', 'Text the first value returned must equal.'),
  mode: z.enum(['fields', 'connectionString'], { error: 'mode must be one of: fields, connectionString' }).optional()
    .meta({ description: 'fields uses host/port/credentials; connectionString takes the whole connection string from a vault secret.', default: 'fields' }),
  tls: z.enum(DATABASE_TLS_MODES, { error: `tls must be one of: ${DATABASE_TLS_MODES.join(', ')}` }).optional().meta({
    description: 'Connection security in fields mode. prefer is what an absent value means (encrypted, certificate not checked, plain if the server has no TLS); the console starts new monitors at verify, which checks the certificate. Prefer verify.',
    default: 'prefer', suggested: 'verify',
  }),
  tlsCa: z.string({ error: `tlsCa must be PEM text of at most ${MAX_TLS_CA_LENGTH} characters` }).refine(within(MAX_TLS_CA_LENGTH), { error: `tlsCa must be PEM text of at most ${MAX_TLS_CA_LENGTH} characters` })
    .optional().meta({ description: 'PEM of the authority that signed the server certificate, for tls: verify.', maxLength: MAX_TLS_CA_LENGTH }),
  vault: VAULT,
} satisfies { [Key in keyof Required<DatabaseConfig>]: z.ZodType }

/** In fields mode a database monitor needs a host (and a port, if not the engine's usual one); with a connection string it uses neither. */
const databaseSchema = z.looseObject(databaseShape)
  .superRefine((config, ctx) => {
    if (config.mode === 'connectionString') return
    if (!isHost(config.host)) ctx.addIssue({ code: 'custom', message: HOST_MESSAGE, path: ['host'] })
    else if (config.port !== undefined && !isPort(config.port)) ctx.addIssue({ code: 'custom', message: PORT_MESSAGE, path: ['port'] })
  })
  .meta({
    if: { properties: { mode: { const: 'connectionString' } }, required: ['mode'] },
    else: { required: ['host'] },
  })

// ── Services that open a socket ─────────────────────────────────────────────

const redisShape = {
  host: host('Redis host.'),
  port: port('Port.', { suggested: 6379 }),
  tls: flag('tls', 'Connects over TLS from the first byte.', { default: false }),
  ...socketTls,
  username: text('username', MAX_TEXT_LENGTH, 'ACL user.'),
  password: text('password', MAX_TEXT_LENGTH, `Password. ${SECRET_NOTE}`),
  vault: VAULT,
} satisfies { [Key in keyof Required<RedisConfig>]: z.ZodType }

const mailPorts = MAIL_PROTOCOLS.map((protocol) => `${protocol} ${MAIL_SECURITY_MODES.map((mode) => MAIL_DEFAULT_PORTS[protocol][mode]).join('/')} (none/starttls/tls)`).join('; ')
const mailShape = {
  protocol: z.enum(MAIL_PROTOCOLS, { error: `protocol must be one of: ${MAIL_PROTOCOLS.join(', ')}` }).meta({ description: 'Which service to greet.' }),
  security: z.enum(MAIL_SECURITY_MODES, { error: `security must be one of: ${MAIL_SECURITY_MODES.join(', ')}` }).meta({ description: 'none, starttls (upgrade after the greeting) or tls (encrypted from the first byte).' }),
  host: host('Mail server host.'),
  port: port(`Port. Usual ones: ${mailPorts}.`),
  ...socketTls,
  username: text('username', MAX_TEXT_LENGTH, 'Signs in when set, so the check proves the account works.'),
  password: text('password', MAX_TEXT_LENGTH, `Password. ${SECRET_NOTE}`),
  vault: VAULT,
} satisfies { [Key in keyof Required<MailConfig>]: z.ZodType }

const sshShape = {
  host: host('SSH host.'),
  port: port('Port.', { suggested: 22 }),
  expectedBanner: text('expectedBanner', 255, 'Text the server identification string must contain (up to 255 characters).'),
} satisfies { [Key in keyof Required<SshConfig>]: z.ZodType }

const tlsShape = {
  host: host('Host to connect to.'),
  port: port('Port.', { suggested: 443 }),
  warnDays: warnDays('The check turns Degraded this many days before the certificate expires.', DEFAULT_CERT_WARN_DAYS),
  ...socketTls,
  servername: text('servername', MAX_HOST_LENGTH, 'Name sent for SNI and matched against the certificate; defaults to host.'),
} satisfies { [Key in keyof Required<TlsCertConfig>]: z.ZodType }

const DOMAIN_MESSAGE = 'domain must be a registered domain name such as example.com'
const domainShape = {
  domain: z.string({ error: DOMAIN_MESSAGE }).refine((value) => !!normalizeDomain(value), { error: DOMAIN_MESSAGE })
    .meta({ description: 'Registered domain name, for example example.com.' }),
  warnDays: warnDays('The check turns Degraded this many days before the registration expires.', DEFAULT_EXPIRY_WARN_DAYS),
} satisfies { [Key in keyof Required<DomainConfig>]: z.ZodType }

// ── Docker, heartbeat ───────────────────────────────────────────────────────

const CONTAINER_REQUIRED = 'Container name or ID is required'
/** What parseDockerEndpoint answers for nothing, which is what a missing or non-text endpoint has always got. */
const ENDPOINT_MISSING = (() => {
  try { parseDockerEndpoint(''); return 'Endpoint is required' } catch (error) { return error instanceof Error ? error.message : String(error) }
})()
const dockerShape = {
  container: z.string({ error: CONTAINER_REQUIRED })
    .refine((value) => value.trim().length > 0, { error: CONTAINER_REQUIRED })
    .refine((value) => CONTAINER_NAME.test(value.trim()), { error: 'Container name may only contain letters, digits, "_", "." and "-"' })
    .meta({ description: 'Container name or ID (letters, digits, _ . -).' }),
  endpoint: z.string({ error: ENDPOINT_MISSING })
    .superRefine((value, ctx) => {
      try { parseDockerEndpoint(value) } catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) }) }
    })
    .meta({ description: 'Docker Engine API: unix:///var/run/docker.sock, npipe:////./pipe/docker_engine, or http(s)://host:port. unix:// is not supported on Windows hosts.' }),
} satisfies { [Key in keyof Required<DockerConfig>]: z.ZodType }

const webhookShape = {} satisfies { [Key in keyof Required<WebhookConfig>]: z.ZodType }

// ── The catalogue ───────────────────────────────────────────────────────────

/** Unknown keys are let through: a config can hold leftovers of another type, and judging them would reject saved monitors. */
export const MONITOR_CONFIG_SCHEMAS = {
  https: z.looseObject(httpsShape),
  ping: pingSchema,
  dns: z.looseObject(dnsShape),
  sqlserver: databaseSchema,
  postgresql: databaseSchema,
  mysql: databaseSchema,
  mongodb: databaseSchema,
  oracle: databaseSchema,
  redis: z.looseObject(redisShape),
  mail: z.looseObject(mailShape),
  ssh: z.looseObject(sshShape),
  tls: z.looseObject(tlsShape),
  domain: z.looseObject(domainShape),
  docker: z.looseObject(dockerShape),
  webhook: z.looseObject(webhookShape),
} satisfies Record<MonitorType, z.ZodType>

/** Only the response-time limit and the assertions of an HTTPS config; the Test button judges these before it runs. */
export const HTTPS_CHECKS_SCHEMA = z.looseObject(httpsChecks)

/** The first thing wrong with the value, in the order the fields are declared, or null. */
export function firstProblem(schema: z.ZodType, value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'config must be an object'
  const result = schema.safeParse(value)
  return result.success ? null : result.error.issues[0]?.message ?? 'The configuration is not valid'
}

/** What is wrong with the config of a monitor of this type, or null. */
export function validateMonitorConfig(type: MonitorType, config: unknown): string | null {
  return firstProblem(MONITOR_CONFIG_SCHEMAS[type], config)
}

const SAFE_INTEGER_BOUND = Number.MAX_SAFE_INTEGER

/** JSON Schema of the config of a type, as it is meant to be read (without the noise a number check adds). */
export function configJsonSchema(type: MonitorType): { type: 'object'; properties: Record<string, Record<string, unknown>>; required?: string[] } {
  const raw = z.toJSONSchema(MONITOR_CONFIG_SCHEMAS[type], { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  const { $schema: _schema, additionalProperties: _extra, ...schema } = raw
  const properties = Object.fromEntries(Object.entries((schema['properties'] ?? {}) as Record<string, Record<string, unknown>>).map(([name, property]) => {
    const { minimum, maximum, ...rest } = property
    return [name, {
      ...rest,
      ...(typeof minimum === 'number' && Math.abs(minimum) < SAFE_INTEGER_BOUND ? { minimum } : {}),
      ...(typeof maximum === 'number' && Math.abs(maximum) < SAFE_INTEGER_BOUND ? { maximum } : {}),
    }]
  }))
  return { ...schema, type: 'object', properties } as { type: 'object'; properties: Record<string, Record<string, unknown>>; required?: string[] }
}
