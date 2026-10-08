import { describe, expect, it } from 'vitest'
import { CHANNEL_TYPES, CHANNEL_TYPE_ORDER, buildChannelConfig, initialDrafts, isChannelType } from './channelTypes'

describe('channel type descriptors', () => {
  it('describes every type offered in the switcher', () => {
    expect(CHANNEL_TYPE_ORDER.map((type) => CHANNEL_TYPES[type].label)).toEqual(['Email', 'Webhook', 'Discord', 'Teams', 'Slack'])
    expect(isChannelType('slack')).toBe(true)
    expect(isChannelType('pager')).toBe(false)
  })

  it('reads the stored config back for its own type and starts the others blank', () => {
    const drafts = initialDrafts('webhook', { url: 'https://hook.test', method: 'PUT', headers: { 'X-Key': 'k' } })

    expect(drafts.webhook).toMatchObject({ url: 'https://hook.test', method: 'PUT', headers: [['X-Key', 'k']] })
    expect(drafts.webhook.body).toContain('"monitor": "{{monitor_name}}"')
    expect(drafts.email).toEqual(CHANNEL_TYPES.email.defaultDraft())
    expect(drafts.slack).toEqual({ webhookUrl: '', text: '' })
  })

  it('round-trips each stored config through parse and build', () => {
    const configs = {
      email: { to: 'ops@example.test', subject: 'S', body: 'B' },
      webhook: { url: 'https://hook.test', method: 'POST', headers: { A: '1' }, body: '{}' },
      discord: { webhookUrl: 'https://discord.test', username: 'BSP', avatarUrl: 'https://img.test/a.png', content: 'hi' },
      teams: { webhookUrl: 'https://teams.test', summary: 'Alert' },
      slack: { webhookUrl: 'https://slack.test', text: 'Heads up' },
    }
    for (const type of CHANNEL_TYPE_ORDER) {
      expect(buildChannelConfig(type, initialDrafts(type, configs[type]))).toEqual(configs[type])
    }
  })

  it('drops empty optional values and unnamed headers when building', () => {
    const drafts = initialDrafts(null, undefined)
    drafts.webhook = { url: 'https://hook.test', method: 'GET', headers: [['', 'x']], body: '{}' }

    expect(buildChannelConfig('webhook', drafts)).toEqual({ url: 'https://hook.test', method: 'GET', headers: undefined, body: undefined })
    expect(buildChannelConfig('discord', drafts)).toEqual({ webhookUrl: '' })
  })
})
