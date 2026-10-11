import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { buildConfigDocuments } from '../src/services/configExport.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-config-export-empty-')

before(() => initTestDb())
after(() => teardownTestDb(testDb))

describe('config export of a new installation', () => {
  it('has no documents', async () => {
    assert.deepEqual(await buildConfigDocuments(), [])
  })
})
