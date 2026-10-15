import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { openDatabase, runMigrations } from '@better-kit/db'
import { auditDbModule, auditLog, createAudit } from '@better-kit/audit'

const dir = mkdtempSync(join(tmpdir(), 'kit-audit-'))
const database = openDatabase({ path: join(dir, 'db.sqlite'), schema: { auditLog } })
const audit = createAudit({ db: database.db })
const admin = audit.actor({ userId: 1, email: 'admin@example.test' })

before(() => runMigrations(database.sqlite, [auditDbModule], { log: () => undefined }))
after(() => { database.close(); rmSync(dir, { recursive: true, force: true }) })

describe('diffs and snapshots', () => {
  it('keep only changed keys and mask sensitive ones at any depth', () => {
    assert.deepEqual(audit.diffObjects({ name: 'a', password: 'x' }, { name: 'b', password: 'y' }), {
      name: { from: 'a', to: 'b' },
      password: { from: '[redacted]', to: '[redacted]' },
    })
    assert.deepEqual(audit.snapshot({ id: 1, nested: { apiToken: 't', list: [{ clientSecret: 's', ok: 1 }] } }), {
      id: 1, nested: { apiToken: '[redacted]', list: [{ clientSecret: '[redacted]', ok: 1 }] },
    })
  })

  it('take the keys to mask from the options', () => {
    const custom = createAudit({ db: database.db, sensitiveKeys: /pin/i })
    assert.deepEqual(custom.snapshot({ pin: '1234', password: 'visible' }), { pin: '[redacted]', password: 'visible' })
  })
})

describe('write and the read route', () => {
  it('stores redacted entries and serves them newest first, filtered and paged', async () => {
    await audit.write(admin, 'create', 'note', 1, 'First', { password: 'p', title: 'a' })
    await audit.write(admin, 'update', 'note', 1, 'First')
    await audit.write(admin, 'delete', 'tag', null, 'Gone')

    const app = Fastify({ logger: false })
    await app.register(audit.routes, { prefix: '/audit' })
    try {
      const all = (await app.inject('/audit/')).json() as { entries: Array<{ action: string; diff: unknown }>; total: number; pages: number }
      assert.equal(all.total, 3)
      assert.deepEqual(all.entries.map((e) => e.action).sort(), ['create', 'delete', 'update'])
      const created = all.entries.find((e) => e.action === 'create')!
      assert.deepEqual(created.diff, { password: '[redacted]', title: 'a' })

      const tags = (await app.inject('/audit/?entityType=tag')).json() as { entries: unknown[]; total: number }
      assert.equal(tags.total, 1)
      const paged = (await app.inject('/audit/?limit=2&page=2')).json() as { entries: unknown[]; pages: number; limit: number }
      assert.deepEqual([paged.entries.length, paged.pages, paged.limit], [1, 2, 2])
      assert.equal(((await app.inject('/audit/?limit=9999')).json() as { limit: number }).limit, 100)
    } finally {
      await app.close()
    }
  })

  it('never lets a failed write break the caller', async () => {
    const empty = openDatabase({ path: join(dir, 'empty.sqlite'), schema: { auditLog } })
    const broken = createAudit({ db: empty.db })
    const original = console.error
    console.error = () => undefined
    try {
      await assert.doesNotReject(broken.write(admin, 'create', 'note', 1, 'No table'))
    } finally {
      console.error = original
      empty.close()
    }
  })
})
