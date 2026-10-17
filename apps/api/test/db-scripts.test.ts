import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, it } from 'node:test'
import bcrypt from 'bcryptjs'

const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'bsp-db-scripts-test-'))
const databasePath = join(dataDir, 'db.sqlite')
const setupPath = join(dataDir, 'setup.json')

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function runScript(script: string, extra: Record<string, string> = {}) {
  const environment = {
    ...process.env,
    DATABASE_PATH: databasePath,
    SETUP_CONFIG_PATH: setupPath,
    ADMIN_EMAIL: '',
    ADMIN_PASSWORD: '',
    ...extra,
  }
  return spawnSync(process.execPath, ['--import', 'tsx', join(process.cwd(), script)], { env: environment, encoding: 'utf8' })
}

function count(table: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  } finally {
    database.close()
  }
}

describe('db:migrate and db:seed scripts', () => {
  it('db:seed without administrator credentials fails and leaves no database behind', () => {
    const result = runScript('apps/api/src/db/seed.ts')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /ADMIN_EMAIL and ADMIN_PASSWORD/)
    assert.equal(fs.existsSync(databasePath), false)
    assert.equal(fs.existsSync(setupPath), false)
  })

  it('db:migrate creates the schema and can be run again', () => {
    const first = runScript('apps/api/src/cli/migrate.ts')
    assert.equal(first.status, 0, first.stderr)
    assert.equal(count('users'), 0)
    const second = runScript('apps/api/src/cli/migrate.ts')
    assert.equal(second.status, 0, second.stderr)
    assert.equal(fs.existsSync(setupPath), false, 'migrating alone must not mark the setup as done')
  })

  it('db:seed creates the administrator, branding and layout, marks the setup done and is idempotent', async () => {
    const seeded = runScript('apps/api/src/db/seed.ts', { ADMIN_EMAIL: 'seed-admin@example.test', ADMIN_PASSWORD: 'seed-password-1' })
    assert.equal(seeded.status, 0, seeded.stderr)
    assert.match(seeded.stdout, /Seed complete/)
    assert.equal(JSON.parse(fs.readFileSync(setupPath, 'utf8')).setupComplete, true)

    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const admin = database.prepare('SELECT email, role, password_hash AS hash FROM users').get() as { email: string; role: string; hash: string }
      assert.equal(admin.email, 'seed-admin@example.test')
      assert.equal(admin.role, 'admin')
      assert.equal(await bcrypt.compare('seed-password-1', admin.hash), true)
    } finally {
      database.close()
    }
    assert.equal(count('branding'), 1)
    assert.equal(count('layout'), 1)

    const again = runScript('apps/api/src/db/seed.ts', { ADMIN_EMAIL: 'other@example.test', ADMIN_PASSWORD: 'another-password-1' })
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /Admin user already exists/)
    assert.equal(count('users'), 1)
    assert.equal(count('branding'), 1)
    assert.equal(count('layout'), 1)
  })
})
