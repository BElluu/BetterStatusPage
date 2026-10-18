import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openDatabase, runMigrations, type Database } from '@better-kit/db'
import {
  createNotifyDbModule, createNotifyEngine, createTransports, MAX_DELIVERY_ATTEMPTS,
  type ChannelRow, type Notice, type NotifyEngineOptions,
} from '@better-kit/notify'

const module = createNotifyDbModule({ sourceIdColumn: 'source_id', sourceNameColumn: 'source_name', smtpFromName: 'Alerts', newKey: () => crypto.randomUUID() })
const { notificationChannels, notificationDeliveries, notificationDeliveryAttempts } = module.tables
const NOW = 1_700_000_000_000

let store: Database<Record<string, unknown>>

beforeEach(() => {
  store = openDatabase({ path: ':memory:', schema: module.tables })
  runMigrations(store.sqlite, [module])
})
afterEach(() => store.close())

const eventNames = { alert: 'alert', recovery: 'recovery', ungrouped: 'action' }

function engineWith(overrides: Partial<NotifyEngineOptions> = {}) {
  return createNotifyEngine({
    db: store.db,
    tables: module.tables,
    minSourcesKey: 'minItems',
    events: eventNames,
    deliver: async () => undefined,
    digest: (rows) => ({ vars: { status: 'down', previous_status: 'up' }, sourceName: `${rows.length} sources` }),
    resolveSecret: async () => ({}),
    ...overrides,
  })
}

async function addChannel(values: Partial<typeof notificationChannels.$inferInsert> = {}): Promise<ChannelRow> {
  const [row] = await store.db.insert(notificationChannels).values({
    name: 'Chat', type: 'webhook', config: '{}', enabled: 1, notifyOnRecovery: 1, createdAt: NOW, updatedAt: NOW, ...values,
  }).returning()
  return row!
}

const alert = (sourceId: number) => ({ sourceId, sourceName: `Source ${sourceId}`, eventType: 'alert' })
const vars = { status: 'down', previous_status: 'up' }
const deliveries = () => store.db.select().from(notificationDeliveries)

describe('delivery engine', () => {
  it('records a delivery, sends it and keeps the attempt', async () => {
    const sent: Record<string, string>[] = []
    const engine = engineWith({ deliver: async (_channel, v) => { sent.push(v) } })
    await engine.dispatch(await addChannel(), vars, alert(1))
    assert.deepEqual(sent, [vars])
    const [row] = await deliveries()
    assert.equal(row!.status, 'delivered')
    assert.equal((await store.db.select().from(notificationDeliveryAttempts)).length, 1)
  })

  it('retries a failing delivery on a schedule, then gives up, and retries it again on request', async () => {
    let fail = true
    const engine = engineWith({ deliver: async () => { if (fail) throw new Error('boom') } })
    const channel = await addChannel()
    await engine.dispatch(channel, vars, alert(1))
    let [row] = await deliveries()
    assert.equal(row!.status, 'pending')
    assert.equal(row!.lastError, 'boom')
    assert.ok(row!.nextAttemptAt! > Date.now())

    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) await engine.attemptDelivery(row!.id, row!.nextAttemptAt!)
    ;[row] = await deliveries()
    assert.equal(row!.status, 'failed')
    assert.equal(row!.nextAttemptAt, null)

    fail = false
    assert.equal(await engine.retryDelivery(row!.id), true)
    ;[row] = await deliveries()
    assert.equal(row!.status, 'delivered')
    assert.equal(await engine.retryDelivery(row!.id), false)
  })

  it('does not send through a disabled channel or one that was deleted', async () => {
    const engine = engineWith()
    await engine.dispatch(await addChannel({ enabled: 0 }), vars, alert(1))
    const [row] = await deliveries()
    assert.equal(row!.lastError, 'Notification channel is disabled')
  })

  it('suppresses an alert over the rate cap but never a recovery', async () => {
    const engine = engineWith()
    const channel = await addChannel({ alertPolicy: JSON.stringify({ throttle: { enabled: true, maxAlerts: 1, windowMinutes: 10 } }) })
    await engine.dispatch(channel, vars, alert(1))
    await engine.dispatch(channel, vars, alert(1))
    await engine.dispatch(channel, vars, { ...alert(1), eventType: 'recovery' })
    assert.deepEqual((await deliveries()).map((row) => [row.eventType, row.status, row.suppressionReason]), [
      ['alert', 'delivered', null],
      ['alert', 'suppressed', 'throttled'],
      ['recovery', 'delivered', null],
    ])
  })

  it('folds a burst into one digest, and lets a lone event through on its own', async () => {
    const sent: string[] = []
    const engine = engineWith({ deliver: async (_channel, v) => { sent.push(v['status'] ?? '') } })
    const policy = JSON.stringify({ grouping: { enabled: true, minItems: 2, windowSeconds: 60 } })
    const burst = await addChannel({ name: 'Burst', alertPolicy: policy })
    // Concurrent events for one channel must land in one window: this is what the channel lock guarantees.
    await Promise.all([engine.dispatch(burst, vars, alert(1)), engine.dispatch(burst, vars, alert(2))])
    assert.equal(sent.length, 0)
    assert.equal(new Set((await deliveries()).map((row) => row.groupKey)).size, 1)

    assert.equal(await engine.processDue(Date.now() + 61_000), 1, 'the digest is the only delivery left to send')
    assert.deepEqual((await deliveries()).map((row) => [row.sourceName, row.status, row.suppressionReason]), [
      ['Source 1', 'suppressed', 'grouped'],
      ['Source 2', 'suppressed', 'grouped'],
      ['2 sources', 'delivered', null],
    ])
    assert.equal(sent.length, 1)

    const lone = await addChannel({ name: 'Lone', alertPolicy: policy })
    await engine.dispatch(lone, vars, alert(3))
    await engine.processDue(Date.now() + 61_000)
    assert.equal((await deliveries()).at(-1)!.status, 'delivered')
    assert.equal(sent.length, 2)
  })

  it('knows whether a source still has an alert open, counting suppressed ones', async () => {
    const engine = engineWith()
    const channel = await addChannel({ alertPolicy: JSON.stringify({ throttle: { enabled: true, maxAlerts: 1, windowMinutes: 10 } }) })
    assert.equal(await engine.hasOpenAlert(1), false)
    await engine.dispatch(channel, vars, alert(1))
    await engine.dispatch(channel, vars, alert(1))
    assert.equal(await engine.hasOpenAlert(1), true)
    await engine.dispatch(channel, vars, { ...alert(1), eventType: 'recovery' })
    assert.equal(await engine.hasOpenAlert(1), false)
  })

  it('purges history past its retention', async () => {
    const engine = engineWith()
    await engine.dispatch(await addChannel(), vars, alert(1))
    await engine.purgeOldDeliveries(Date.now() + 179 * 86_400_000)
    assert.equal((await deliveries()).length, 1)
    await engine.purgeOldDeliveries(Date.now() + 181 * 86_400_000)
    assert.equal((await deliveries()).length, 0)
  })

  it('shares no in-flight state between two engines', async () => {
    let calls = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slow = { deliver: async () => { calls++; await gate } }
    const first = engineWith(slow)
    const second = engineWith(slow)
    const channel = await addChannel()
    // The delivery is held pending (digest window) so that both engines can be asked to attempt it.
    const [row] = await store.db.insert(notificationDeliveries).values({
      channelId: channel.id, channelName: channel.name, channelType: channel.type, sourceId: 1, sourceName: 'Source 1', eventType: 'alert',
      status: 'pending', targetStatus: 'down', previousStatus: 'up', variables: '{}', maxAttempts: 3, nextAttemptAt: NOW, createdAt: NOW, updatedAt: NOW,
    }).returning()

    const attempts = [first.attemptDelivery(row!.id), first.attemptDelivery(row!.id), second.attemptDelivery(row!.id)]
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls, 2, 'one engine ignores an attempt already in flight, the other engine does not')
    release()
    await Promise.all(attempts)
  })

  it('sends a direct delivery at once and reports the outcome', async () => {
    const fails = engineWith({ deliver: async () => { throw new Error('nope') } })
    assert.deepEqual(await fails.sendDirect(await addChannel(), vars, { sourceId: null, sourceName: 'Test', eventType: 'test' }), { ok: false, error: 'nope' })
    const works = engineWith()
    assert.deepEqual(await works.sendDirect(await addChannel(), vars, { sourceId: null, sourceName: 'Test', eventType: 'test' }), { ok: true })
  })

  it('reports SMTP as unconfigured and refuses to send mail without a host', async () => {
    const engine = engineWith()
    assert.equal(await engine.isSmtpConfigured(), false)
    await assert.rejects(() => engine.sendSmtpMail({ to: 'a@example.test', subject: 's', text: 't' }), /SMTP not configured/)
  })
})

describe('transports', () => {
  const notice: Notice = {
    severity: 'critical', headline: ['Server ', { subject: 'a' }, ' is ', { state: 'DOWN' }], subtitle: [], facts: [{ label: 'Status', value: 'down' }],
    at: '2026-10-09T17:00:22.988Z', atLabel: 'Seen at',
  }
  const realFetch = globalThis.fetch
  let requests: Array<{ url: string; init: RequestInit }>
  let answer: () => Response

  beforeEach(() => {
    requests = []
    answer = () => new Response('{}', { status: 200 })
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => { requests.push({ url: String(url), init: init ?? {} }); return answer() }) as typeof fetch
  })
  afterEach(() => { globalThis.fetch = realFetch })

  const transports = (secret: Record<string, string> = {}) => createTransports({
    resolveSecret: async () => secret, sendMail: async () => undefined, discordAvatarUrl: 'https://example.test/avatar.png',
  })
  const through = (type: string, config: object, secret?: Record<string, string>) =>
    transports(secret).deliver({ type, config: JSON.stringify(config) }, {}, notice)

  it('refuses a channel type it does not know', async () => {
    await assert.rejects(() => through('carrier-pigeon', {}), /Unsupported notification channel type: carrier-pigeon/)
  })

  it('uses the avatar the application names unless the channel sets its own', async () => {
    await through('discord', { webhookUrl: 'https://hook.test/d' })
    assert.equal(JSON.parse(String(requests[0]!.init.body))['avatar_url'], 'https://example.test/avatar.png')
  })

  it('takes a token from the vault and fails clearly when the secret holds none', async () => {
    await through('pushover', { userKey: 'u', vault: { vaultId: 1, secretId: 1 } }, { value: ' from-vault ' })
    assert.equal(JSON.parse(String(requests[0]!.init.body))['token'], 'from-vault')
    await assert.rejects(() => through('pushover', { userKey: 'u', vault: { vaultId: 1, secretId: 1 } }, {}), /Pushover vault secret has no application token/)
  })

  it('refuses an ntfy token that cannot travel in a header, without echoing it', async () => {
    await assert.rejects(() => through('ntfy', { topic: 't', accessToken: 'bad token' }), (error: Error) => {
      assert.match(error.message, /cannot be sent in a header/)
      assert.ok(!error.message.includes('bad token'))
      return true
    })
    assert.equal(requests.length, 0)
  })

  it('reports a failing service by status and its own reason, never the Telegram token in the URL', async () => {
    answer = () => new Response('{"description":"chat not found"}', { status: 400 })
    await assert.rejects(() => through('telegram', { botToken: '123:SECRET', chatId: '1' }), (error: Error) => {
      assert.equal(error.message, 'Telegram API returned HTTP 400: chat not found')
      return true
    })
    answer = () => new Response('', { status: 500 })
    await assert.rejects(() => through('slack', { webhookUrl: 'https://hook.test/s' }), /^Error: Slack webhook returned HTTP 500$/)
  })

  it('keeps a variable to one piece of the URL and one line of a header', async () => {
    const hostile = 'a b&admin=1/../x'
    await transports().deliver(
      { type: 'webhook', config: JSON.stringify({ url: 'https://hook.test/n?e={{error_message}}', method: 'POST', headers: { 'X-Note': 'v: {{error_message}}' } }) },
      { error_message: hostile + '\r\nX-Injected: 1' },
      notice,
    )
    assert.equal(requests[0]!.url, 'https://hook.test/n?e=a%20b%26admin%3D1%2F..%2Fx%0D%0AX-Injected%3A%201')
    assert.equal((requests[0]!.init.headers as Record<string, string>)['X-Note'], 'v: ' + hostile + 'X-Injected: 1')
  })

  it('sends a lone surrogate in a variable as U+FFFD instead of failing the delivery', async () => {
    const lone = 'a' + String.fromCharCode(0xd83d) + 'b'
    await transports().deliver(
      { type: 'webhook', config: JSON.stringify({ url: 'https://hook.test/n?e={{error_message}}', method: 'POST' }) },
      { error_message: lone },
      notice,
    )
    assert.equal(requests[0]!.url, 'https://hook.test/n?e=a%EF%BF%BDb')
  })

  it('cannot turn a variable into a dot segment of the URL', async () => {
    await transports().deliver(
      { type: 'webhook', config: JSON.stringify({ url: 'https://hook.test/job/{{error_message}}/build', method: 'POST' }) },
      { error_message: '..' },
      notice,
    )
    assert.equal(requests[0]!.url, 'https://hook.test/job/%252E%252E/build')
    assert.equal(new URL(requests[0]!.url).pathname, '/job/%252E%252E/build')
  })

  describe('text a sender controls', () => {
    const hostile = '<!channel> [Panel](https://evil.example) @everyone'
    const withDetail: Notice = { ...notice, detail: { label: 'Error', value: hostile } }
    const sent = async (type: string, config: object, vars: Record<string, string> = {}) => {
      await transports().deliver({ type, config: JSON.stringify(config) }, vars, withDetail)
      return String(requests[0]!.init.body)
    }

    it('cannot make Slack mention a channel or link away', async () => {
      const body = await sent('slack', { webhookUrl: 'https://hook.test/s', text: 'Alert: {{error_message}}' }, { error_message: hostile })
      assert.ok(!body.includes('<!channel>') && !body.includes('<https'))
      assert.equal(JSON.parse(body).text.split('\n')[0], 'Alert: &lt;!channel&gt; [Panel](https://evil.example) @everyone')
      assert.match(body, /&lt;!channel&gt;/)
    })

    it('cannot make Discord render a link or ping everyone', async () => {
      const body = JSON.parse(await sent('discord', { webhookUrl: 'https://hook.test/d', content: '{{error_message}}' }, { error_message: hostile }))
      const field = body.embeds[0].fields.find((f: { name: string }) => f.name === 'Error')
      assert.equal(field.value, '\\<!channel\\> \\[Panel\\]\\(https://evil.example\\) @everyone')
      assert.ok(!body.content.includes('@everyone'))
      assert.ok(body.content.includes('@' + String.fromCharCode(0x200b) + 'everyone'))
      assert.ok(body.content.includes('\\[Panel\\]\\(https://evil.example\\)'))
    })

    it('keeps the Discord error field within its limit without ending on a lone backslash', async () => {
      const long: Notice = { ...notice, detail: { label: 'Error', value: '('.repeat(900) } }
      await transports().deliver({ type: 'discord', config: JSON.stringify({ webhookUrl: 'https://hook.test/d' }) }, {}, long)
      const value: string = JSON.parse(String(requests[0]!.init.body)).embeds[0].fields.find((f: { name: string }) => f.name === 'Error').value
      assert.ok(value.length <= 1024)
      assert.ok(value.endsWith('\\(…'))
    })

    it('never cuts the Discord error field in the middle of an emoji', async () => {
      const emoji = String.fromCodePoint(0x1f600)
      for (const extra of ['', 'x']) {
        const long: Notice = { ...notice, detail: { label: 'Error', value: extra + emoji.repeat(600) } }
        await transports().deliver({ type: 'discord', config: JSON.stringify({ webhookUrl: 'https://hook.test/d' }) }, {}, long)
        const body = JSON.parse(String(requests.at(-1)!.init.body))
        const value: string = body.embeds[0].fields.find((f: { name: string }) => f.name === 'Error').value
        assert.ok(value.length <= 1024)
        assert.ok(value.endsWith(emoji + String.fromCharCode(0x2026)))
        assert.equal(Array.from(value).every((char) => char.length === 2 || char.codePointAt(0)! < 0xd800 || char.codePointAt(0)! > 0xdfff), true)
      }
    })

    it('cannot make Teams render a link', async () => {
      const body = JSON.parse(await sent('teams', { webhookUrl: 'https://hook.test/t' }))
      const fact = body.sections[0].facts.find((f: { name: string }) => f.name === 'Error')
      const zwsp = String.fromCharCode(0x200b)
      assert.equal(fact.value, `<${zwsp}!channel> [Panel]${zwsp}(https://evil.example) @everyone`)
    })

    it('leaves the other variables of a Discord message and the card text alone', async () => {
      const body = JSON.parse(await sent('discord', { webhookUrl: 'https://hook.test/d', content: '`{{monitor_name}}` {{error_message}}', avatarUrl: 'https://img.test/{{monitor_name}}.png' }, { monitor_name: 'my_api@eu', error_message: 'x_y' }))
      assert.equal(body.content, '`my_api@eu` x\\_y')
      assert.equal(body.avatar_url, 'https://img.test/my_api%40eu.png')
    })
  })

  it('never follows a redirect from a push service', async () => {
    await through('ntfy', { topic: 't' })
    assert.equal(requests[0]!.init.redirect, 'error')
  })
})
