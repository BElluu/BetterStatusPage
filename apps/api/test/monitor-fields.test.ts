import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MonitorType } from '@bsp/shared'
import { describeMonitorType, MONITOR_FIELDS, MONITOR_SETTINGS, MONITOR_TYPE_SUMMARY, type FieldDoc } from '../src/mcp/monitorFields.js'
import { MONITOR_TYPES, parseNewMonitor } from '../src/services/monitorInput.js'
import { monitorSecretPaths } from '../src/services/secretFields.js'

/**
 * The catalogue an agent reads (monitor_config_fields) is checked against the validator that really decides, so a
 * description that stops being true fails here.
 */
type Config = Record<string, unknown>
const fieldsOf = (type: MonitorType) => Object.entries(MONITOR_FIELDS[type] as Record<string, FieldDoc>)

/** A value that is right for a field, from what the catalogue itself says. */
function sampleValue(name: string, doc: FieldDoc): unknown {
  if (doc.values) return doc.values[0]
  if (doc.default !== undefined) return doc.default
  if (doc.suggested !== undefined) return doc.suggested
  if (name === 'url') return 'https://example.test'
  if (name === 'endpoint') return 'http://localhost:2375'
  if (doc.type === 'number') return doc.min ?? 1
  if (doc.type === 'boolean') return true
  return 'example.test'
}

/** Every field the check needs, so the monitor is valid, and nothing else. */
function sampleConfig(type: MonitorType): Config {
  return Object.fromEntries(fieldsOf(type).filter(([, doc]) => doc.required).map(([name, doc]) => [name, sampleValue(name, doc)]))
}

const parse = (type: string, config: Config, settings: Config = {}) => parseNewMonitor({ name: 'Sample', type, config, ...settings })
const accepted = (result: ReturnType<typeof parse>) => !('error' in result)

describe('the monitor field catalogue', () => {
  it('describes every monitor type, and its sample is accepted by the real validator', () => {
    assert.deepEqual(Object.keys(MONITOR_FIELDS).sort(), [...MONITOR_TYPES].sort())
    assert.deepEqual(Object.keys(MONITOR_TYPE_SUMMARY).sort(), [...MONITOR_TYPES].sort())
    for (const type of MONITOR_TYPES) {
      const result = parse(type, sampleConfig(type))
      assert.ok(accepted(result), `${type}: ${'error' in result ? result.error : ''}`)
    }
  })

  it('says a field is validated exactly when the API refuses a monitor without it', () => {
    for (const type of MONITOR_TYPES) {
      const sample = sampleConfig(type)
      for (const [name, doc] of fieldsOf(type)) {
        if (!doc.required) continue
        const { [name]: _removed, ...without } = sample
        assert.equal(!accepted(parse(type, without)), doc.validated, `${type}.${name}: validated=${doc.validated}`)
      }
    }
  })

  it('never calls a field both validated and defaulted, and defaults only what the check can do without', () => {
    for (const type of MONITOR_TYPES) {
      for (const [name, doc] of fieldsOf(type)) {
        if (doc.validated) assert.equal(doc.default, undefined, `${type}.${name} is refused when absent, so it has no default`)
        if (doc.default !== undefined) assert.equal(doc.required, false, `${type}.${name}`)
        if (doc.validated) assert.equal(doc.required, true, `${type}.${name}`)
      }
    }
  })

  it('lists exactly the values the API accepts for the choices it checks', () => {
    for (const type of MONITOR_TYPES) {
      for (const [name, doc] of fieldsOf(type)) {
        if (!doc.values || !doc.validated) continue
        for (const value of doc.values) assert.ok(accepted(parse(type, { ...sampleConfig(type), [name]: value })), `${type}.${name} = ${value}`)
        assert.ok(!accepted(parse(type, { ...sampleConfig(type), [name]: '__bogus__' })), `${type}.${name} accepts a made-up value`)
      }
    }
    // The database engines check their own choice.
    for (const value of MONITOR_FIELDS.postgresql.tls.values!) assert.ok(accepted(parse('postgresql', { host: 'h', port: 5432, database: 'd', user: 'u', tls: value })), value)
    assert.ok(!accepted(parse('postgresql', { host: 'h', port: 5432, database: 'd', user: 'u', tls: '__bogus__' })))
  })

  it('states the ranges the API enforces', () => {
    for (const type of MONITOR_TYPES) {
      for (const [name, doc] of fieldsOf(type)) {
        if (!doc.validated || doc.type !== 'number' || doc.min === undefined || doc.max === undefined) continue
        const make = (value: number) => parse(type, { ...sampleConfig(type), [name]: value })
        assert.ok(accepted(make(doc.min)), `${type}.${name} min`)
        assert.ok(accepted(make(doc.max)), `${type}.${name} max`)
        assert.ok(!accepted(make(doc.min - 1)), `${type}.${name} below min`)
        assert.ok(!accepted(make(doc.max + 1)), `${type}.${name} above max`)
      }
    }
    assert.ok(!accepted(parse('ssh', { ...sampleConfig('ssh'), expectedBanner: 'x'.repeat(256) })), 'banner limit')
    assert.ok(accepted(parse('ssh', { ...sampleConfig('ssh'), expectedBanner: 'x'.repeat(255) })))
    assert.ok(!accepted(parse('https', { url: 'https://a.test', degradedAboveMs: 0 })))
    assert.ok(accepted(parse('https', { url: 'https://a.test', degradedAboveMs: MONITOR_FIELDS.https.degradedAboveMs.max })))
  })

  it('states the ranges of the settings every monitor has', () => {
    const make = (name: string, value: number) => parse('https', { url: 'https://a.test' }, { [name]: value })
    for (const [name, doc] of Object.entries(MONITOR_SETTINGS)) {
      if (doc.min === undefined || doc.max === undefined) continue
      assert.ok(accepted(make(name, doc.min)), `${name} min`)
      assert.ok(accepted(make(name, doc.max)), `${name} max`)
      // The thresholds are brought into their range instead of refused, which their description says.
      const brought = name === 'failureThreshold' || name === 'recoveryThreshold'
      assert.equal(accepted(make(name, doc.min - 1)), brought, `${name} below min`)
      assert.equal(accepted(make(name, doc.max + 1)), brought, `${name} above max`)
      if (brought) assert.match(doc.description, /brought into it/)
    }
  })

  it('has the defaults it names: what the API fills in when the field is absent', () => {
    const parsed = parseNewMonitor({ name: 'Defaults', type: 'https', config: { url: 'https://a.test' } })
    assert.ok(!('error' in parsed))
    const value = (parsed as unknown as { value: Record<string, unknown> }).value
    for (const name of ['intervalSecs', 'timeoutMs', 'retries', 'failureThreshold', 'recoveryThreshold', 'autoIncidentMode', 'latencyAlertWindowMinutes', 'latencyAlertMinDeltaMs', 'latencyAlertSustain']) {
      const doc = MONITOR_SETTINGS[name]!
      assert.equal(value[name], doc.default, `${name}: the catalogue says ${String(doc.default)}`)
    }
  })

  it('marks as secret exactly what the secret table masks', () => {
    for (const type of MONITOR_TYPES) {
      const described = describeMonitorType(type).config
      const marked = described.flatMap((field) => field.secret ? [field.name] : (field.secretPaths ?? []))
      assert.deepEqual([...marked].sort(), [...monitorSecretPaths(type)].sort(), type)
    }
    const https = describeMonitorType('https').config
    assert.deepEqual(https.find((field) => field.name === 'auth')!.secretPaths, ['auth.basic.password', 'auth.oauth2.clientSecret', 'auth.cas.password'])
    assert.deepEqual(https.find((field) => field.name === 'headers')!.secretPaths, ['headers.*'])
    assert.equal(describeMonitorType('postgresql').config.find((field) => field.name === 'password')!.secret, true)
    assert.ok(describeMonitorType('webhook').config.every((field) => !field.secret))
  })

  it('tells an agent what the console does differently from the API for a database', () => {
    const tls = describeMonitorType('postgresql').config.find((field) => field.name === 'tls')!
    assert.deepEqual([tls.default, tls.suggested], ['prefer', 'verify'])
    assert.match(tls.description, /Prefer verify/)
    assert.equal(describeMonitorType('tls').config.find((field) => field.name === 'warnDays')!.suggested, 14)
  })
})
