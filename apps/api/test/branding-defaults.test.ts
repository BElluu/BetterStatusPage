import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_BRANDING_COLORS } from '@bsp/shared'
import { closeDb, db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { branding } from '../src/db/schema.js'

const LIGHT_MODE_TOKENS = {
  primaryColor: '--m3-primary', accentColor: '--m3-on-primary-container',
  backgroundColor: '--m3-surface', cardBackground: '--m3-surface-container-low',
  elevatedBackground: '--m3-surface-container-high', chartBackground: '--m3-surface-container-low',
  cardBorderColor: '--m3-outline-variant', chartGridColor: '--m3-outline-variant',
  textColor: '--m3-on-surface', textMutedColor: '--m3-secondary',
  statusUpColor: '--m3-up-bar', statusDownColor: '--m3-down', statusDegradedColor: '--m3-degraded-bar',
} as const

test('default branding colors match the actual public light-mode CSS tokens', () => {
  const css = readFileSync(join(process.cwd(), 'apps/status/src/index.css'), 'utf8')
  const lightModeCss = css.slice(css.indexOf(':root {'), css.indexOf('html.dark'))
  for (const [field, token] of Object.entries(LIGHT_MODE_TOKENS)) {
    const match = lightModeCss.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`))
    assert.equal(match?.[1], DEFAULT_BRANDING_COLORS[field as keyof typeof LIGHT_MODE_TOKENS], `${field} should match ${token}`)
  }
})

test('legacy branding data migrates safely and only once', async () => {
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
      logoUrl: '/uploads/legacy-logo.png',
      updatedAt: Date.now(),
    })
    sqlite.prepare('DELETE FROM schema_migrations WHERE name IN (?, ?)').run(
      'branding-defaults-match-light-mode-v2',
      'branding-legacy-logo-variants-v1',
    )

    runMigrations()
    const migrated = (await db.select().from(branding))[0]!
    for (const [field, value] of Object.entries(DEFAULT_BRANDING_COLORS)) {
      assert.equal(migrated[field as keyof typeof DEFAULT_BRANDING_COLORS], value)
    }
    assert.equal(migrated.logoLightUrl, '/uploads/legacy-logo.png')
    assert.equal(migrated.logoDarkUrl, '/uploads/legacy-logo.png')

    sqlite.prepare('UPDATE branding SET enabled = 1, primary_color = ?, card_background = ?').run('#123456', '#f2f0fd')
    sqlite.prepare('DELETE FROM schema_migrations WHERE name = ?').run('branding-defaults-match-light-mode-v2')
    runMigrations()
    const activeCustomBranding = (await db.select().from(branding))[0]!
    assert.equal(activeCustomBranding.primaryColor, '#123456')
    assert.equal(activeCustomBranding.cardBackground, '#f2f0fd')

    sqlite.prepare('UPDATE branding SET enabled = 0, card_background = ?').run('#f2f0fd')
    runMigrations()
    assert.equal((await db.select().from(branding))[0]!.cardBackground, '#f2f0fd')
  } finally {
    closeDb()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
