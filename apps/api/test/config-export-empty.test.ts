import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { config, DOCUMENT_KINDS } from '../src/kit/config.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-config-export-empty-')

before(() => initTestDb())
after(() => teardownTestDb(testDb))

describe('config export of a new installation', () => {
  it('has no documents', async () => {
    assert.deepEqual(await config.exportDocuments(undefined, { included: new Set<string>(DOCUMENT_KINDS) }), [])
  })
})
