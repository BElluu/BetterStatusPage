import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { backfillKeys, ENTITY_KEY_ERROR, isValidEntityKey, keyForNew, randomEntityKey, slugifyKey } from '@better-forge/config-as-code'

describe('entity keys', () => {
  it('accepts lowercase letters, digits, - and _, starting with a letter or digit, up to 64 characters', () => {
    for (const key of ['a', '0', 'ops-slack', 'a_b', 'x'.repeat(64)]) assert.equal(isValidEntityKey(key), true, key)
    for (const key of ['', '-a', '_a', 'A', 'a b', 'x'.repeat(65), 'ł', 5, null, undefined]) assert.equal(isValidEntityKey(key), false, String(key))
  })

  it('makes a slug of a name: accents dropped, ł as l, dashes collapsed, cut at 48, "item" when nothing is left', () => {
    assert.equal(slugifyKey('Ops Slack'), 'ops-slack')
    assert.equal(slugifyKey('Łódź — główny'), 'lodz-glowny')
    assert.equal(slugifyKey('  --A!!B--  '), 'a-b')
    assert.equal(slugifyKey('★★★'), 'item')
    assert.equal(slugifyKey('a'.repeat(60)).length, 48)
    assert.equal(slugifyKey(`${'a'.repeat(47)} b`), 'a'.repeat(47))
  })

  it('makes random keys that are valid keys', () => {
    assert.match(randomEntityKey(), /^k-[0-9a-f]{10}$/)
    assert.equal(isValidEntityKey(randomEntityKey()), true)
  })

  it('takes the requested key when valid and free, and refuses a bad or taken one with the status to answer', async () => {
    const taken = new Map([['used', 7]])
    const owner = async (key: string) => taken.get(key)
    assert.deepEqual(await keyForNew('Name', 'free-key', owner), { key: 'free-key' })
    assert.deepEqual(await keyForNew('Name', 'Bad Key', owner), { status: 400, error: ENTITY_KEY_ERROR })
    assert.deepEqual(await keyForNew('Name', 'used', owner), { status: 409, error: 'Key "used" is already in use' })
  })

  it('derives a key from the name and adds -2, -3 on a collision', async () => {
    const taken = new Set(['ops', 'ops-2'])
    const owner = async (key: string) => taken.has(key) ? 1 : undefined
    assert.deepEqual(await keyForNew('Ops', undefined, owner), { key: 'ops-3' })
    assert.deepEqual(await keyForNew('Fresh', undefined, owner), { key: 'fresh' })
  })
})

describe('backfill of keys', () => {
  it('gives rows without a key one from their name in id order, and leaves existing keys alone', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT, key TEXT NOT NULL DEFAULT '');
      CREATE TABLE others (id INTEGER PRIMARY KEY, name TEXT, key TEXT NOT NULL DEFAULT '');
      INSERT INTO things (name, key) VALUES ('Ops', ''), ('Ops', ''), ('Keep me', 'custom'), ('Ops', 'ops-2'), ('Ops', '');
      INSERT INTO others (name) VALUES ('Other');`)
    backfillKeys(sqlite, ['things'])
    const keys = (table: string) => (sqlite.prepare(`SELECT key FROM ${table} ORDER BY id`).all() as Array<{ key: string }>).map((row) => row.key)
    assert.deepEqual(keys('things'), ['ops', 'ops-3', 'custom', 'ops-2', 'ops-4'])
    assert.deepEqual(keys('others'), [''], 'tables that were not named are not touched')
    backfillKeys(sqlite, ['things', 'others'])
    assert.deepEqual(keys('things'), ['ops', 'ops-3', 'custom', 'ops-2', 'ops-4'])
    assert.deepEqual(keys('others'), ['other'])
  })
})
