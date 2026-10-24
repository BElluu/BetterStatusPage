import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { DEFAULT_EMAIL_BODY, DEFAULT_EMAIL_SUBJECT } from '@bsp/shared'
import { sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

// The channels of an action were once called failure channels, and a channel worded its messages about an action with
// the fields it had for monitors. An upgrade keeps the links and gives what such a channel said to its Action wording.
const testDb = createTestDb('bsp-action-channels-migration-')
before(() => initTestDb())
after(() => teardownTestDb(testDb))

const OLD_TABLE = `CREATE TABLE action_failure_channels (id INTEGER PRIMARY KEY AUTOINCREMENT, action_id INTEGER NOT NULL, channel_id INTEGER NOT NULL)`

function addChannel(name: string, type: string, config: Record<string, unknown>): number {
  const now = Date.now()
  const row = sqlite.prepare('INSERT INTO notification_channels (name, type, config, enabled, notify_on_recovery, created_at, updated_at, key) VALUES (?, ?, ?, 1, 0, ?, ?, ?) RETURNING id')
    .get(name, type, JSON.stringify(config), now, now, name.toLowerCase().replace(/\W/g, '-')) as { id: number }
  return row.id
}

const configOf = (id: number) => JSON.parse((sqlite.prepare('SELECT config FROM notification_channels WHERE id = ?').get(id) as { config: string }).config) as Record<string, unknown>
const links = () => (sqlite.prepare('SELECT action_id AS a, channel_id AS c FROM action_notification_channels ORDER BY c').all() as { a: number; c: number }[]).map((l) => [l.a, l.c])
const downgrade = (alsoNewTable: boolean) => {
  sqlite.exec('DELETE FROM action_notification_channels')
  if (!alsoNewTable) sqlite.exec('DROP TABLE action_notification_channels')
  sqlite.exec(OLD_TABLE)
  sqlite.exec("DELETE FROM schema_migrations WHERE name = 'action-failure-channels-renamed-v1'")
}

describe('action channels migration', () => {
  it('keeps the links and copies the wording of the linked channels, not of the others', () => {
    const webhook = addChannel('Hook', 'webhook', { url: 'https://x.test/h', method: 'POST', body: '{"monitor":"{{monitor_name}}"}' })
    const slack = addChannel('Chat', 'slack', { webhookUrl: 'https://h.test/s', text: '<!here> {{monitor_name}}' })
    const stock = addChannel('Mail', 'email', { to: 'a@b.test', subject: DEFAULT_EMAIL_SUBJECT, body: DEFAULT_EMAIL_BODY })
    const custom = addChannel('Mail2', 'email', { to: 'a@b.test', subject: 'Mine', body: 'Body' })
    const bare = addChannel('Plain', 'discord', { webhookUrl: 'https://d.test/w' })
    const unlinked = addChannel('Other', 'slack', { webhookUrl: 'https://h.test/o', text: 'not for actions' })
    downgrade(false)
    sqlite.exec(`INSERT INTO action_failure_channels (action_id, channel_id) VALUES (1, ${webhook}), (1, ${slack}), (2, ${stock}), (2, ${custom}), (2, ${bare})`)

    runMigrations()

    assert.deepEqual(links(), [[1, webhook], [1, slack], [2, stock], [2, custom], [2, bare]])
    assert.equal(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'action_failure_channels'").get(), undefined)
    assert.deepEqual(configOf(webhook)['eventOverrides'], { action: { body: '{"monitor":"{{monitor_name}}"}' } })
    assert.deepEqual(configOf(slack)['eventOverrides'], { action: { text: '<!here> {{monitor_name}}' } })
    assert.deepEqual(configOf(custom)['eventOverrides'], { action: { subject: 'Mine', body: 'Body' } })
    // Nothing to copy: the stock email template, no wording at all, and a channel no action uses.
    for (const id of [stock, bare, unlinked]) assert.equal(configOf(id)['eventOverrides'], undefined)
    assert.equal(configOf(webhook)['body'], '{"monitor":"{{monitor_name}}"}')
  })

  it('does not run twice, and never overwrites wording a channel already has for actions', () => {
    const id = addChannel('Worded', 'slack', { webhookUrl: 'https://h.test/w', text: 'monitor text', eventOverrides: { action: { text: 'action text' } } })
    downgrade(false)
    sqlite.exec(`INSERT INTO action_failure_channels (action_id, channel_id) VALUES (1, ${id})`)
    runMigrations()
    runMigrations()
    assert.deepEqual(configOf(id)['eventOverrides'], { action: { text: 'action text' } })
    assert.deepEqual(links(), [[1, id]])
  })

  it('moves the links when a build had already created the new table', () => {
    const id = addChannel('Both', 'slack', { webhookUrl: 'https://h.test/b', text: 'x' })
    downgrade(true)
    sqlite.exec(`INSERT INTO action_failure_channels (action_id, channel_id) VALUES (3, ${id})`)
    runMigrations()
    assert.deepEqual(links(), [[3, id]])
    assert.equal(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'action_failure_channels'").get(), undefined)
  })

  it('does nothing on a database that never had the old table', () => {
    const before = links()
    runMigrations()
    assert.deepEqual(links(), before)
  })
})
