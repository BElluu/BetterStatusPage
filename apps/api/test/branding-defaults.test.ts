import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_BRANDING_COLORS } from '@bsp/shared'
import { closeDb, db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { branding } from '../src/db/schema.js'

test('branding defaults match light mode and legacy defaults migrate once', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bsp-branding-defaults-'))
  process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')

  try {
    initDb()
    runMigrations()
    await db.insert(branding).values({
      id: 1,
      siteName: 'Status Page',
      primaryColor: '#5256a4',
      accentColor: '#5c5faa',
      backgroundColor: '#faf8ff',
      cardBackground: '#f2f0fd',
      cardBorderColor: '#c8c5d0',
      textColor: '#1b1b22',
      textMutedColor: '#5d5c72',
      statusUpColor: '#1a7f37',
      statusDownColor: '#c0392b',
      statusDegradedColor: '#b05c00',
      updatedAt: Date.now(),
    })
    sqlite.prepare('DELETE FROM schema_migrations WHERE name = ?').run('branding-defaults-match-light-mode-v1')

    runMigrations()
    const migrated = (await db.select().from(branding))[0]!
    for (const [field, value] of Object.entries(DEFAULT_BRANDING_COLORS)) {
      assert.equal(migrated[field as keyof typeof DEFAULT_BRANDING_COLORS], value)
    }

    sqlite.prepare('UPDATE branding SET primary_color = ?').run('#123456')
    sqlite.prepare('DELETE FROM schema_migrations WHERE name = ?').run('branding-defaults-match-light-mode-v1')
    runMigrations()
    assert.equal((await db.select().from(branding))[0]!.primaryColor, '#123456')
  } finally {
    closeDb()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
