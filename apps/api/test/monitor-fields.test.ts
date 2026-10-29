import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MonitorType } from '@bsp/shared'
import { describeMonitorType, MONITOR_SETTINGS, MONITOR_TYPE_SUMMARY } from '../src/mcp/monitorFields.js'
import { configJsonSchema, MONITOR_CONFIG_SCHEMAS, validateMonitorConfig } from '../src/services/monitorConfigSchema.js'
import { MONITOR_TYPES, parseMonitorPatch, parseNewMonitor } from '../src/services/monitorInput.js'
import { validateDockerConfig } from '../src/workers/docker.js'
import { validateHttpAssertions } from '../src/workers/assertions.js'
import { monitorSecretPaths } from '../src/services/secretFields.js'

/**
 * What an agent reads (monitor_config_fields) is the JSON Schema of the very schema the API judges a config with, so
 * these tests do not compare two descriptions: they check that what the schema SAYS about itself is true when the real
 * validator is fed, in both directions.
 */
type Config = Record<string, unknown>
type Property = Record<string, unknown> & { format?: string; type?: string; enum?: unknown[]; const?: unknown; default?: unknown; suggested?: unknown; minimum?: number; maximum?: number; maxLength?: number; unchecked?: boolean; needed?: boolean }

const propertiesOf = (type: MonitorType) => Object.entries(configJsonSchema(type).properties) as Array<[string, Property]>
/** What the API refuses to go without: the required keys, and what a schema says is required in the usual case (`else`). */
const requiredOf = (type: MonitorType) => {
  const schema = configJsonSchema(type) as { required?: string[]; else?: { required?: string[] } }
  return [...(schema.required ?? []), ...(schema.else?.required ?? [])]
}
const accepted = (type: MonitorType, config: Config) => validateMonitorConfig(type, config) === null

/** A value that is right for a field, from what the schema itself says. */
function sampleValue(name: string, property: Property): unknown {
  if (property.enum) return property.enum[0]
  if (property.default !== undefined) return property.default
  if (property.suggested !== undefined) return property.suggested
  if (name === 'url') return 'https://example.test'
  if (name === 'endpoint') return 'http://localhost:2375'
  if (name === 'container') return 'web'
  if (property.type === 'integer' || property.type === 'number') return property.minimum ?? 1
  if (property.type === 'boolean') return true
  return 'example.test'
}

/** Every field the monitor needs, whether the API checks it or not, and nothing else. */
function sampleConfig(type: MonitorType): Config {
  return Object.fromEntries(propertiesOf(type).filter(([name, property]) => requiredOf(type).includes(name) || property.needed).map(([name, property]) => [name, sampleValue(name, property)]))
}

describe('the monitor config schema', () => {
  it('describes every monitor type, and its sample is accepted by the real validator', () => {
    assert.deepEqual(Object.keys(MONITOR_CONFIG_SCHEMAS).sort(), [...MONITOR_TYPES].sort())
    assert.deepEqual(Object.keys(MONITOR_TYPE_SUMMARY).sort(), [...MONITOR_TYPES].sort())
    for (const type of MONITOR_TYPES) {
      const result = parseNewMonitor({ name: 'Sample', type, config: sampleConfig(type) })
      assert.ok(!('error' in result), `${type}: ${'error' in result ? result.error : ''}`)
    }
  })

  it('lists as required exactly what the API refuses to go without', () => {
    for (const type of MONITOR_TYPES) {
      const sample = sampleConfig(type)
      for (const [name, property] of propertiesOf(type)) {
        if (!(name in sample)) continue
        const { [name]: _removed, ...without } = sample
        assert.equal(!accepted(type, without), requiredOf(type).includes(name), `${type}.${name}`)
        // What is needed but not required is the part the API leaves to the check.
        if (!requiredOf(type).includes(name)) assert.equal(property.needed, true, `${type}.${name} is neither required nor marked needed`)
      }
    }
  })

  it('says unchecked exactly where the API accepts anything', () => {
    for (const type of MONITOR_TYPES) {
      for (const [name, property] of propertiesOf(type)) {
        for (const wrongValue of [{ notAValidValue: true }, [1]]) {
          const wrong = { ...sampleConfig(type), [name]: wrongValue }
          assert.equal(accepted(type, wrong), property.unchecked === true, `${type}.${name} = ${JSON.stringify(wrongValue)}`)
        }
      }
    }
  })

  it('lists exactly the values the API accepts for the choices it checks', () => {
    for (const type of MONITOR_TYPES) {
      for (const [name, property] of propertiesOf(type)) {
        if (!property.enum || property.unchecked) continue
        for (const value of property.enum) assert.ok(accepted(type, { ...sampleConfig(type), [name]: value }), `${type}.${name} = ${String(value)}`)
        assert.ok(!accepted(type, { ...sampleConfig(type), [name]: '__bogus__' }), `${type}.${name} accepts a made-up value`)
      }
    }
  })

  it('states the numeric ranges and text lengths the API enforces', () => {
    for (const type of MONITOR_TYPES) {
      for (const [name, property] of propertiesOf(type)) {
        if (property.unchecked) continue
        const make = (value: unknown) => accepted(type, { ...sampleConfig(type), [name]: value })
        if (property.minimum !== undefined && property.maximum !== undefined) {
          assert.ok(make(property.minimum) && make(property.maximum), `${type}.${name} bounds`)
          assert.ok(!make(property.minimum - 1) && !make(property.maximum + 1), `${type}.${name} outside the bounds`)
          if (property.type === 'integer') assert.ok(!make(property.minimum + 0.5), `${type}.${name} accepts a fraction`)
        }
        if (property.maxLength !== undefined && property.type === 'string' && property.format === undefined) {
          assert.ok(make('a'.repeat(property.maxLength)), `${type}.${name} longest`)
          assert.ok(!make('a'.repeat(property.maxLength + 1)), `${type}.${name} too long`)
        }
      }
    }
  })

  it('describes an assertion the way the checker reads it', () => {
    const items = (configJsonSchema('https').properties['assertions'] as { items: { oneOf: Array<{ properties: Record<string, Property>; required: string[] }> } }).items.oneOf
    const [header, json] = items as [typeof items[number], typeof items[number]]
    const check = (assertions: unknown[]) => accepted('https', { url: 'https://a.test', assertions })
    for (const op of header.properties['op']!.enum as string[]) {
      assert.ok(check([{ type: 'header', name: 'X-Replicas', op, value: '2' }]), `header ${op}`)
    }
    for (const op of json.properties['op']!.enum as string[]) {
      assert.ok(check([{ type: 'json', path: '$.queue.length', op, value: 3 }]), `json ${op}`)
    }
    assert.ok(!check([{ type: 'header', name: 'X-A', op: '__bogus__', value: '1' }]))
    assert.ok(!check([{ type: 'json', path: 'queue', op: 'exists' }]), 'a path must start with $')
    assert.ok(!check([{ type: 'header', name: 'X-A', op: 'equals' }]), 'a value is needed for equals')
    assert.ok(check([{ type: 'header', name: 'X-A', op: 'exists' }]), 'but not for exists')
    const long = 'a'.repeat(1001)
    assert.ok(!check([{ type: 'header', name: 'X-A', op: 'equals', value: long }]) && !check([{ type: 'json', path: '$.a', op: 'equals', value: long }]), 'a value is at most 1000 characters')
    assert.equal((json.properties['value'] as Property).maxLength, 1000)
    assert.equal((header.properties['value'] as Property).maxLength, 1000)
    // What the description calls required is what the checker insists on.
    assert.deepEqual(header.required, ['type', 'name', 'op'])
    assert.deepEqual(json.required, ['type', 'path', 'op'])
  })

  it('marks as secret exactly what the secret table masks', () => {
    for (const type of MONITOR_TYPES) {
      const properties = describeMonitorType(type).configSchema.properties as Record<string, Property & { secret?: boolean; secretPaths?: string[] }>
      const marked = Object.entries(properties).flatMap(([name, property]) => property.secret ? [name] : (property.secretPaths ?? []))
      assert.deepEqual([...marked].sort(), [...monitorSecretPaths(type)].sort(), type)
    }
    const https = describeMonitorType('https').configSchema.properties as Record<string, { secretPaths?: string[] }>
    assert.deepEqual(https['auth']!.secretPaths, ['auth.basic.password', 'auth.oauth2.clientSecret', 'auth.cas.password'])
    assert.deepEqual(https['headers']!.secretPaths, ['headers.*'])
    assert.equal((describeMonitorType('postgresql').configSchema.properties['password'] as { secret?: boolean }).secret, true)
  })

  it('tells an agent what the console does differently from the API for a database', () => {
    const tls = configJsonSchema('postgresql').properties['tls'] as Property
    assert.deepEqual([tls.default, tls.suggested], ['prefer', 'verify'])
    assert.match(String(tls['description']), /Prefer verify/)
    assert.equal((configJsonSchema('tls').properties['warnDays'] as Property).suggested, 14)
    assert.equal((configJsonSchema('domain').properties['warnDays'] as Property).suggested, 30)
  })

  it('is plain JSON Schema an agent can read, and small', () => {
    for (const type of MONITOR_TYPES) {
      const schema = configJsonSchema(type)
      const text = JSON.stringify(schema)
      assert.ok(!('$schema' in schema) && !text.includes('9007199254740991'), type)
      assert.ok(text.length < 8_000, `${type}: ${text.length} characters`)
    }
  })
})

describe('the settings every monitor has', () => {
  const accepts = (settings: Config) => !('error' in parseNewMonitor({ name: 'Settings', type: 'https', config: { url: 'https://a.test' }, ...settings }))

  it('states their ranges', () => {
    for (const [name, doc] of Object.entries(MONITOR_SETTINGS)) {
      if (doc.min === undefined || doc.max === undefined) continue
      assert.ok(accepts({ [name]: doc.min }) && accepts({ [name]: doc.max }), `${name} bounds`)
      // The thresholds are brought into their range instead of refused, which their description says.
      const brought = name === 'failureThreshold' || name === 'recoveryThreshold'
      assert.equal(accepts({ [name]: doc.min - 1 }), brought, `${name} below min`)
      assert.equal(accepts({ [name]: doc.max + 1 }), brought, `${name} above max`)
      if (brought) assert.match(doc.description, /brought into it/)
    }
  })

  it('has the defaults it names: what the API fills in when the field is absent', () => {
    const parsed = parseNewMonitor({ name: 'Defaults', type: 'https', config: { url: 'https://a.test' } })
    assert.ok(!('error' in parsed))
    const value = (parsed as unknown as { value: Record<string, unknown> }).value
    for (const name of ['intervalSecs', 'timeoutMs', 'retries', 'failureThreshold', 'recoveryThreshold', 'autoIncidentMode', 'latencyAlertWindowMinutes', 'latencyAlertMinDeltaMs', 'latencyAlertSustain']) {
      assert.equal(value[name], MONITOR_SETTINGS[name]!.default, name)
    }
  })
})

/**
 * What the hand-written validators did before the schema replaced them, pinned so that it stays so: the messages, which
 * problem comes first, how long is long, and what is let through.
 */
describe('what the API has always answered', () => {
  const problem = (type: MonitorType, config: unknown) => validateMonitorConfig(type, config)
  const HOST = 'host is required and must not contain spaces'
  const U = 'https://example.test'
  const DB = { host: 'db.example.test', port: 5432 }
  const emoji = (count: number) => '\u{1F4A9}'.repeat(count)

  it('counts length in UTF-16 units, so an emoji is two', () => {
    assert.equal(problem('ssh', { host: emoji(126), port: 22 }), null, '252 units')
    assert.equal(problem('ssh', { host: emoji(127), port: 22 }), HOST, '254 units')
    assert.equal(problem('redis', { host: 'h', port: 1, password: emoji(512) }), null)
    assert.equal(problem('redis', { host: 'h', port: 1, password: emoji(513) }), 'password must be text of at most 1024 characters')
    assert.equal(problem('ssh', { host: 'h', port: 22, expectedBanner: emoji(127) }), null)
    assert.equal(problem('ssh', { host: 'h', port: 22, expectedBanner: emoji(128) }), 'expectedBanner must be text of at most 255 characters')
    assert.equal(problem('tls', { host: 'h', port: 443, warnDays: 14, servername: emoji(126) }), null)
    assert.equal(problem('tls', { host: 'h', port: 443, warnDays: 14, servername: emoji(127) }), 'servername must be text of at most 253 characters')
    assert.equal(problem('postgresql', { ...DB, tlsCa: emoji(32_769) }), 'tlsCa must be PEM text of at most 65536 characters')
    // And a bad host is reported before a bad port, as it always was.
    assert.equal(problem('ssh', { host: emoji(127), port: 1e21 }), HOST)
  })

  it('reports the first problem in the order the fields have always been checked', () => {
    assert.equal(problem('mail', { protocol: 'x', security: 'y', host: '', port: 0, verifyTls: 'q', tlsCa: 1, username: 1, password: 1 }), 'protocol must be one of: smtp, imap, pop3')
    assert.equal(problem('mail', { protocol: 'smtp', security: 'y', host: '', port: 0 }), 'security must be one of: none, starttls, tls')
    assert.equal(problem('tls', { host: '', port: 0, warnDays: 0 }), HOST)
    assert.equal(problem('tls', { host: 'h', port: 0, warnDays: 0 }), 'port must be a whole number from 1 to 65535')
    assert.equal(problem('https', { url: U, degradedAboveMs: 0, assertions: 'x', ignoreTls: 'x' }), 'degradedAboveMs must be a whole number of milliseconds from 1 to 300000')
    assert.equal(problem('https', { url: U, assertions: 'x', ignoreTls: 'x' }), 'assertions must be a list')
    assert.equal(problem('https', { url: U, ignoreTls: 'x', cacheBuster: 'x' }), 'ignoreTls must be true or false')
    assert.equal(problem('docker', { container: '..', endpoint: 'x' }), 'Container name may only contain letters, digits, "_", "." and "-"')
    assert.equal(problem('docker', { container: 'ok', endpoint: 'x' }), 'Endpoint must start with unix://, npipe://, http:// or https://')
    assert.equal(problem('redis', { host: 'h', port: 1, tls: 'x', verifyTls: 'x' }), 'tls must be true or false')
    assert.equal(problem('redis', { host: 'h', port: 1, verifyTls: 'x', tlsCa: 1 }), 'verifyTls must be true or false')
  })

  it('says there are too many assertions before it looks at any of them', () => {
    assert.equal(problem('https', { url: U, assertions: Array.from({ length: 25 }, () => 1) }), 'At most 20 assertions are allowed')
    assert.equal(problem('https', { url: U, assertions: [1] }), 'Assertion 1 must be an object')
    assert.equal(problem('https', { url: U, assertions: [{ type: 'header', name: 'X', op: 'equals', value: 'a' }, { type: 'x' }] }), 'Assertion 2: type must be "header" or "json"')
    assert.equal(problem('https', { url: U, assertions: [{ onFail: 'x', type: 'x' }] }), 'Assertion 1: onFail must be "degraded" or "down"')
  })

  it('refuses every kind of whitespace in a host', () => {
    for (const space of [' ', '\u00a0', '\u2003', '\u2028', '\ufeff', '\t', '\n']) {
      assert.equal(problem('ssh', { host: `a${space}b`, port: 22 }), HOST, JSON.stringify(space))
    }
    assert.equal(problem('ssh', { host: '', port: 22 }), HOST)
    assert.equal(problem('ssh', { host: 5, port: 22 }), HOST)
  })

  it('answers with the same words for the choices of a database', () => {
    const tls = 'tls must be one of: prefer, require, verify'
    for (const wrong of ['VERIFY', null, 5, 'x']) assert.equal(problem('postgresql', { ...DB, tls: wrong }), tls, String(wrong))
    for (const right of ['prefer', 'require', 'verify']) assert.equal(problem('postgresql', { ...DB, tls: right }), null)
    assert.equal(problem('postgresql', { ...DB, tlsCa: 5 }), 'tlsCa must be PEM text of at most 65536 characters')
    assert.equal(problem('oracle', { ...DB, tls: 'bad', tlsCa: 5 }), tls, 'tls is looked at before tlsCa')
  })

  it('lets through what it does not know, and stays clean while doing so', () => {
    // A config can hold the leftovers of another type, and judging them would reject monitors that are saved.
    assert.equal(problem('redis', { host: 'h', port: 1, url: 5, assertions: 'x', method: ['x'] }), null)
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"host":"h","port":1}') as unknown
    assert.equal(problem('redis', hostile), null)
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined)
    assert.equal(problem('webhook', { anything: { at: 'all' } }), null)
  })

  it('answers one thing for a config that is not an object, whichever way it is asked', () => {
    for (const bad of [null, undefined, [], 'x', 5]) {
      assert.equal(problem('redis', bad), 'config must be an object')
      assert.equal(validateHttpAssertions(bad as never), 'config must be an object')
    }
    assert.equal(validateDockerConfig(null), 'Docker config must be an object')
    assert.equal(validateDockerConfig([]), 'config must be an object')
  })
})

/** Stage B: what the API refuses now that the schema checks these types, and what it still lets through. */
describe('the checked configs of https, ping, dns and the databases', () => {
  const created = (type: string, config: unknown) => parseNewMonitor({ name: 'Checked', type, config })
  const ok = (type: string, config: unknown) => assert.ok(!('error' in created(type, config)), `${type} ${JSON.stringify(config)}`)
  const refused = (type: string, config: unknown, message: RegExp) => {
    const result = created(type, config)
    assert.ok('error' in result, `${type} ${JSON.stringify(config)} was accepted`)
    assert.match(result.error, message)
  }

  it('needs an address a browser could open for https', () => {
    const notAnAddress = /url must be a full address starting with http:\/\/ or https:\/\//
    for (const url of [undefined, '', 'example.com', 'ftp://example.com', '//example.com', 'javascript:alert(1)', 5, null]) {
      refused('https', url === undefined ? {} : { url }, notAnAddress)
    }
    // What a fetch would still read as an address, but code that looks at the text itself would not.
    for (const url of ['https:example.com', 'http:/x', 'http:\\\\a.com', ' https://a.test', 'https://a.test ', 'https://a.\ncom', 'https://' + 'a'.repeat(2050)]) {
      refused('https', { url }, notAnAddress)
    }
    refused('https', { url: 'https://user:secret@a.test/' }, /must not contain a user name or password/)
    refused('https', { url: 'https://user@a.test/' }, /must not contain a user name or password/)
    ok('https', { url: 'https://example.test' })
    ok('https', { url: 'HTTPS://EXAMPLE.TEST' })
    ok('https', { url: 'http://10.0.0.5:8080/health?x=1' })
    ok('https', { url: 'http://[::1]:8080/' })
    ok('https', { url: `https://a.test/${'a'.repeat(2000)}` })
    assert.equal((configJsonSchema('https').properties['url'] as Property).maxLength, 2048)
  })

  it('lets https send only GET, POST or HEAD, in any case, and expect a real status', () => {
    for (const method of ['DELETE', 'PUT', 'PATCH', 'TRACE', '', 5, null]) refused('https', { url: 'https://a.test', method }, /method must be one of: GET, POST, HEAD/)
    for (const method of ['GET', 'get', 'Post', 'HEAD']) ok('https', { url: 'https://a.test', method })
    for (const expectedStatus of [100, 199, 600, 200.5, '200', null]) refused('https', { url: 'https://a.test', expectedStatus }, /expectedStatus must be a whole number from 200 to 599/)
    for (const expectedStatus of [200, 204, 301, 599]) ok('https', { url: 'https://a.test', expectedStatus })
    // The checks that were there before are still there, after the address.
    refused('https', { url: 'https://a.test', ignoreTls: 'x' }, /ignoreTls must be true or false/)
    refused('https', { ignoreTls: 'x' }, /url must be/)
  })

  it('needs a host for ping and a name for dns, and checks the choices they are given', () => {
    refused('ping', {}, /host is required/)
    refused('ping', { host: 'a b', mode: 'tcp' }, /host is required/)
    refused('ping', { host: 'example.test', mode: 'udp' }, /mode must be one of: tcp, icmp/)
    refused('ping', { host: 'example.test', mode: 'TCP' }, /mode must be one of: tcp, icmp/)
    for (const port of [0, 65_536, 80.5, '80', null]) refused('ping', { host: 'example.test', mode: 'tcp', port }, /port must be a whole number from 1 to 65535/)
    // Saved before the mode was required: it ran as tcp on port 80, and still does.
    ok('ping', { host: 'example.test' })
    ok('ping', { host: 'example.test', mode: 'tcp' })
    ok('ping', { host: 'example.test', mode: 'tcp', port: 443 })
    // A port belongs to tcp: the form shows it for icmp too, and clearing it must not make the monitor invalid.
    ok('ping', { host: 'example.test', mode: 'icmp' })
    ok('ping', { host: 'example.test', mode: 'icmp', port: 0 })
    ok('ping', { host: 'example.test', mode: 'icmp', port: '' })

    refused('dns', {}, /hostname is required and must not contain spaces/)
    refused('dns', { hostname: 'a.test', recordType: 'SRV' }, /recordType must be one of: A, AAAA, MX, CNAME, TXT/)
    refused('dns', { hostname: 'a.test', recordType: 'a' }, /recordType must be one of/)
    ok('dns', { hostname: 'a.test' })
    ok('dns', { hostname: 'a.test', recordType: 'TXT', expectedValue: 'v=spf1', resolver: '1.1.1.1' })
  })

  it('needs a host from a database unless it uses a connection string', () => {
    for (const type of ['sqlserver', 'postgresql', 'mysql', 'mongodb', 'oracle'] as const) {
      refused(type, {}, /host is required/)
      refused(type, { host: 'db.test', port: 0 }, /port/)
      refused(type, { host: 'db.test', port: null }, /port/)
      refused(type, { host: 'db.test', port: 70_000 }, /port/)
      refused(type, { mode: 'fields' }, /host is required/)
      refused(type, { host: 'db.test', port: 1, mode: 'dsn' }, /mode must be one of: fields, connectionString/)
      ok(type, { host: 'db.test', port: 1, database: 'd', user: 'u' })
      // Saved without a port: the driver uses the usual one of the engine.
      ok(type, { host: 'db.test', database: 'd', user: 'u' })
      // With the connection string in a vault secret, the fields are not used and may be left out.
      ok(type, { mode: 'connectionString', vault: { vaultId: 1, secretId: 1 } })
      ok(type, { mode: 'connectionString', host: '', port: null })
    }
  })

  it('keeps what a database was always free about, and the order it reported in', () => {
    ok('postgresql', { host: 'db.test', port: 5432, tls: 'verify', query: 'SELECT 1', expectedResult: '1', user: 'u', database: 'd', password: 'p' })
    ok('postgresql', { host: 'db.test', port: 5432, whatever: { is: 'left' } })
    // A wrong choice is reported before a missing host, as the field checks always came first.
    refused('postgresql', { tls: 'bad' }, /tls must be one of/)
  })

  it('applies to a change as well as to a new monitor', () => {
    const existing = { id: 1, type: 'https', config: '{"url":"https://a.test"}', intervalSecs: 60, timeoutMs: 10_000, retries: 1, failureThreshold: 1, recoveryThreshold: 1 }
    const patched = parseMonitorPatch({ config: { url: 'https://a.test', method: 'DELETE' } }, existing as never)
    assert.ok('error' in patched && /method must be one of/.test(patched.error))
    assert.ok(!('error' in parseMonitorPatch({ config: { url: 'https://b.test', method: 'HEAD' } }, existing as never)))
    // Moving a monitor to another type needs that type's config, which the schema judges too.
    const moved = parseMonitorPatch({ type: 'dns', config: { recordType: 'A' } }, existing as never)
    assert.ok('error' in moved && /hostname is required/.test(moved.error))
    assert.ok(!('error' in parseMonitorPatch({ type: 'ping', config: { host: 'a.test' } }, existing as never)))
    // A monitor saved before these fields were required can be sent back whole, as the admin form does.
    for (const [type, config] of [['ping', { host: 'a.test' }], ['dns', { hostname: 'a.test' }], ['postgresql', { host: 'db', database: 'd', user: 'u' }]] as const) {
      assert.ok(!('error' in parseMonitorPatch({ name: 'Renamed', config }, { ...existing, type } as never)), type)
    }
    // Changing only the name does not look at the config it already has.
    assert.ok(!('error' in parseMonitorPatch({ name: 'Renamed' }, { ...existing, config: '{}' } as never)))
  })

  it('tells an agent which of these fields are required, and that the choices are closed', () => {
    const https = configJsonSchema('https') as { required: string[]; properties: Record<string, Property & { format?: string }> }
    assert.deepEqual(https.required, ['url'])
    assert.equal(https.properties['url']!.format, 'uri')
    assert.deepEqual(https.properties['method']!.enum, ['GET', 'POST', 'HEAD'])
    assert.deepEqual((configJsonSchema('ping') as { required: string[] }).required, ['host'])
    assert.deepEqual((configJsonSchema('dns') as { required: string[] }).required, ['hostname'])
    assert.equal((configJsonSchema('ping').properties['mode'] as Property).default, 'tcp')
    assert.equal((configJsonSchema('dns').properties['recordType'] as Property).default, 'A')
    const db = configJsonSchema('postgresql') as { required?: string[]; if?: unknown; else?: { required: string[] } }
    assert.deepEqual(db.else?.required, ['host'])
    assert.ok(db.if, 'and that a connection string is the way out of that')
  })
})
