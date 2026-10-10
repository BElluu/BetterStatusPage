import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { buildConfigDocument } from '../src/services/configExport.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-config-export-empty-')

before(() => initTestDb())
after(() => teardownTestDb(testDb))

describe('config export of a new installation', () => {
  it('is an empty page with nothing to configure', async () => {
    assert.deepEqual(await buildConfigDocument(), {
      version: 1, channels: [], monitors: [], layout: { id: 'root', type: 'page', children: [] },
    })
  })
})
