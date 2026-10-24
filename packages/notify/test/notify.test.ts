import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildWebhookRequest, channelConfigError, configForEvent, createAlertPolicy, DEFAULT_ALERT_POLICY, isWithinQuietHours, quietHoursEndAt, readableTimestamp,
  renderSegments, substituteVars, type NoticeSegment,
} from '@better-kit/notify'

describe('alert policy', () => {
  const policy = createAlertPolicy({ minSourcesKey: 'minItems' })

  it('reads the grouping threshold under the key the application chose and clamps it', () => {
    assert.equal(policy.normalizeAlertPolicy({ grouping: { minItems: 7 } }).grouping.minSources, 7)
    assert.equal(policy.normalizeAlertPolicy({ grouping: { minItems: 1 } }).grouping.minSources, 2)
    assert.equal(policy.normalizeAlertPolicy({ grouping: { minSources: 7 } }).grouping.minSources, DEFAULT_ALERT_POLICY.grouping.minSources)
  })

  it('writes the stored form with the application key and the keys in their usual order', () => {
    const wire = policy.toWire(policy.parseAlertPolicy('{"grouping":{"minItems":5,"enabled":true}}'))
    assert.deepEqual(Object.keys(wire.grouping), ['enabled', 'minItems', 'windowSeconds'])
    assert.equal(wire.grouping['minItems'], 5)
    assert.deepEqual(Object.keys(wire), ['quietHours', 'throttle', 'grouping'])
  })

  it('falls back to the defaults for anything unusable', () => {
    for (const stored of [null, '', 'not json', '[]']) assert.deepEqual(policy.parseAlertPolicy(stored), DEFAULT_ALERT_POLICY)
  })

  it('finds quiet hours, also when the window wraps midnight, and when they end', () => {
    const quiet = { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC', mode: 'defer' as const }
    const at = (hour: number) => Date.UTC(2024, 0, 15, hour, 0, 0)
    assert.equal(isWithinQuietHours(quiet, at(23)), true)
    assert.equal(isWithinQuietHours(quiet, at(3)), true)
    assert.equal(isWithinQuietHours(quiet, at(12)), false)
    assert.equal(quietHoursEndAt(quiet, at(23)), Date.UTC(2024, 0, 16, 7, 0, 0))
  })
})

describe('templates', () => {
  it('leaves unknown variables as written and escapes values only where asked', () => {
    assert.equal(substituteVars('{{a}} {{b}}', { a: '1' }), '1 {{b}}')
    const request = buildWebhookRequest({ url: 'https://x.test/{{id}}', method: 'POST', headers: { 'X-Id': '{{id}}' }, body: '{"m":"{{msg}}"}' }, { id: '7', msg: 'say "hi"\n' })
    assert.equal(request.url, 'https://x.test/7')
    assert.equal(request.init.headers['X-Id'], '7')
    assert.deepEqual(JSON.parse(request.init.body!), { m: 'say "hi"\n' })
  })
})

describe('channel input', () => {
  it('asks for what a channel type needs and refuses an edited mask', () => {
    assert.equal(channelConfigError('telegram', { chatId: '1', botToken: 'abc' }), null)
    assert.match(channelConfigError('telegram', { chatId: '1' }) ?? '', /Bot Token/)
    assert.match(channelConfigError('telegram', { chatId: '1', botToken: '••••abcd' }) ?? '', /full bot token/)
    assert.match(channelConfigError('ntfy', { topic: 'bad topic' }) ?? '', /topic/)
    assert.equal(channelConfigError('slack', {}), null)
  })

  it('refuses a webhook URL with a placeholder in the host', () => {
    assert.match(channelConfigError('webhook', { url: 'https://{{error_message}}/x', method: 'POST' }) ?? '', /host of the URL/)
    assert.equal(channelConfigError('webhook', { url: 'https://corp.test/{{error_message}}', method: 'POST' }), null)
  })
})

describe('notice', () => {
  const headline: NoticeSegment[] = [{ kind: 'Server ' }, { subject: 'a<b' }, ' is ', { state: 'DOWN' }]

  it('writes the emphasised segments in the markup of each channel', () => {
    assert.equal(renderSegments(headline, { subject: (v) => `[${v}]`, state: (v) => `*${v}*` }), 'Server [a<b] is *DOWN*')
    assert.equal(renderSegments(headline, { kind: () => '', text: (v) => v.toUpperCase(), subject: (v) => `<${v}>`, state: (v) => v }), '<A<B> IS DOWN')
  })

  it('shows an ISO instant readably and anything else as it is', () => {
    assert.equal(readableTimestamp('2026-10-09T17:00:22.988Z'), '2026-10-09 17:00:22 UTC')
    assert.equal(readableTimestamp('yesterday'), 'yesterday')
    assert.equal(readableTimestamp(undefined), 'unknown')
  })
})

describe('wording per kind of event', () => {
  const webhook = { url: 'https://x.test/hook', method: 'POST', body: '{"m":"{{monitor_name}}"}', eventOverrides: { action: { body: '{"a":"{{action_name}}"}' } } }

  it('lays the wording of an event over the channel, and only the fields that word a message', () => {
    assert.deepEqual(configForEvent('webhook', webhook, 'action')['body'], '{"a":"{{action_name}}"}')
    assert.equal(configForEvent('webhook', webhook, 'alert')['body'], '{"m":"{{monitor_name}}"}')
    // A field that is not a message field can never be replaced, whatever the stored config says.
    const sneaky = { ...webhook, eventOverrides: { action: { url: 'https://evil.test/', body: 'x', headers: 'y' } } }
    const merged = configForEvent('webhook', sneaky, 'action')
    assert.equal(merged['url'], 'https://x.test/hook')
    assert.equal(merged['headers'], undefined)
    assert.equal(merged['body'], 'x')
    // An empty field keeps the channel's own wording.
    assert.equal(configForEvent('email', { to: 'a@b.test', subject: 'S', body: 'B', eventOverrides: { action: { subject: '', body: 'only body' } } }, 'action')['subject'], 'S')
  })

  it('refuses an override that is not made of message fields of the channel type', () => {
    assert.equal(channelConfigError('webhook', webhook), null)
    assert.match(channelConfigError('webhook', { ...webhook, eventOverrides: { action: { url: 'https://evil.test/' } } }) ?? '', /not a message field/)
    assert.match(channelConfigError('slack', { webhookUrl: 'https://h.test', eventOverrides: { action: { subject: 'x' } } }) ?? '', /not a message field/)
    assert.match(channelConfigError('slack', { webhookUrl: 'https://h.test', eventOverrides: { Action: { text: 'x' } } }) ?? '', /invalid event name/)
    assert.match(channelConfigError('slack', { webhookUrl: 'https://h.test', eventOverrides: { action: { text: 5 } } }) ?? '', /must be text/)
    assert.match(channelConfigError('slack', { webhookUrl: 'https://h.test', eventOverrides: [] }) ?? '', /must be an object/)
  })
})

describe('wording of a kind of event the channel does not word itself', () => {
  const wording = { ownEvents: ['alert'], defaults: { action: { webhook: { body: '{"default":true}' } } } }
  const webhook = { url: 'https://x.test/h', method: 'POST', body: '{"monitor":"{{monitor_name}}"}' }

  it('never uses the channel\'s own fields, but its override, or else the default', () => {
    assert.equal(configForEvent('webhook', webhook, 'alert', wording)['body'], '{"monitor":"{{monitor_name}}"}')
    assert.equal(configForEvent('webhook', webhook, 'action', wording)['body'], '{"default":true}')
    const worded = { ...webhook, eventOverrides: { action: { body: '{"mine":true}' } } }
    assert.equal(configForEvent('webhook', worded, 'action', wording)['body'], '{"mine":true}')
    // Without a default, a channel type that has none is left to its standard message.
    const slack = { webhookUrl: 'https://h.test', text: 'for monitors' }
    assert.equal(configForEvent('slack', slack, 'action', wording)['text'], undefined)
    assert.equal(configForEvent('slack', slack, 'action', wording)['webhookUrl'], 'https://h.test')
  })

  it('sends no body with a GET', () => {
    assert.equal('body' in configForEvent('webhook', { ...webhook, method: 'GET' }, 'action', wording), false)
  })
})

describe('event names of a channel\'s wording', () => {
  it('refuses names that exist on every object and never reads an inherited one', () => {
    for (const event of ['__proto__', 'constructor', 'toString', 'prototype']) {
      assert.match(channelConfigError('slack', { webhookUrl: 'https://h.test', eventOverrides: JSON.parse(`{"${event}":{"text":"x"}}`) }) ?? '', /invalid event name/, event)
    }
    const polluted = Object.create({ action: { text: 'inherited' } }) as Record<string, Record<string, string>>
    assert.equal(configForEvent('slack', { webhookUrl: 'https://h.test', eventOverrides: polluted }, 'action')['text'], undefined)
  })
})
