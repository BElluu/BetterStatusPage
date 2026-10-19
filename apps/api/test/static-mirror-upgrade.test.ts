import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { getStaticMirrorSettings, saveStaticMirrorSettings } from '../src/services/staticMirror.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)
const testDb = createTestDb('bsp-static-mirror-upgrade-')

before(() => initTestDb())
after(() => teardownTestDb(testDb))

describe('a database with an earlier shape of the static fallback tables', () => {
  it('is brought up to date and still saves the settings', async () => {
    // As it was while the feature was built: no show_banner column, and a column that has since been dropped from the
    // code, NOT NULL with a default, which an insert that does not name it must not trip over.
    sqlite.exec('ALTER TABLE static_mirror_settings DROP COLUMN show_banner')
    sqlite.exec("ALTER TABLE static_mirror_settings ADD COLUMN public_url TEXT NOT NULL DEFAULT ''")
    sqlite.exec('ALTER TABLE static_mirror_status DROP COLUMN copy_files')

    runMigrations()

    const columns = (table: string) => (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
    assert.ok(columns('static_mirror_settings').includes('show_banner'))
    assert.ok(columns('static_mirror_status').includes('copy_files'))

    const saved = await saveStaticMirrorSettings({ enabled: false, bucket: 'status-copy', region: 'auto', endpoint: 'http://localhost:9000', accessKeyId: 'AKID', secretAccessKey: 'secret', intervalSeconds: 60, showBanner: false })
    assert.equal(saved.showBanner, false)
    assert.equal((await getStaticMirrorSettings()).bucket, 'status-copy')
  })
})
