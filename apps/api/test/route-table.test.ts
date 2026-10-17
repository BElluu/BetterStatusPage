import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'
import { describeRouteTable } from './helpers/routeTable.js'

const SNAPSHOT = fileURLToPath(new URL('./fixtures/route-table.txt', import.meta.url))
const testDb = createTestDb('bsp-route-table-')
process.env['UPLOAD_DIR'] = join(testDb.dir, 'uploads')
process.env['UPDATE_CHECK'] = 'false'

before(() => initTestDb())
after(() => teardownTestDb(testDb))

// Guards the module extraction: the HTTP surface (method, path, token access, token part, role) must not change.
// Regenerate deliberately with UPDATE_SNAPSHOTS=1 when a route is added or changed on purpose.
describe('route table', () => {
  it('matches the committed snapshot', async () => {
    const actual = (await describeRouteTable()).join('\n') + '\n'
    if (process.env['UPDATE_SNAPSHOTS'] === '1' || !existsSync(SNAPSHOT)) {
      mkdirSync(join(SNAPSHOT, '..'), { recursive: true })
      writeFileSync(SNAPSHOT, actual)
    }
    assert.equal(actual, readFileSync(SNAPSHOT, 'utf8').replace(/\r\n/g, '\n'))
  })
})
