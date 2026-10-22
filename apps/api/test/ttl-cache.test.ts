import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { createTtlCache } from '../src/lib/ttlCache.js'

describe('ttl cache', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: 1_000 }))
  afterEach(() => mock.timers.reset())

  const counting = () => {
    let loads = 0
    return { load: async () => ++loads, loads: () => loads }
  }

  it('answers from the first load until it expires, then loads again', async () => {
    const cache = createTtlCache<number>(10_000, 10)
    const source = counting()
    assert.equal(await cache.get('a', source.load), 1)
    mock.timers.tick(9_999)
    assert.equal(await cache.get('a', source.load), 1)
    mock.timers.tick(1)
    assert.equal(await cache.get('a', source.load), 2)
    assert.equal(source.loads(), 2)
  })

  it('keeps each key apart, and lets requests that arrive while loading share the load', async () => {
    const cache = createTtlCache<number>(10_000, 10)
    const source = counting()
    const together = await Promise.all([cache.get('a', source.load), cache.get('a', source.load), cache.get('b', source.load)])
    assert.deepEqual(together, [1, 1, 2])
  })

  it('does not keep a load that failed', async () => {
    const cache = createTtlCache<number>(10_000, 10)
    await assert.rejects(cache.get('a', () => Promise.reject(new Error('boom'))), /boom/)
    assert.equal(await cache.get('a', async () => 7), 7)
  })

  it('drops the expired entries when full, and everything when none has expired', async () => {
    const cache = createTtlCache<number>(10_000, 3)
    const source = counting()
    for (const key of ['a', 'b', 'c']) await cache.get(key, source.load) // 1, 2, 3
    assert.equal(await cache.get('d', source.load), 4) // full and nothing expired: cleared, then d kept
    assert.equal(await cache.get('d', source.load), 4)
    assert.equal(await cache.get('a', source.load), 5) // a was dropped with the rest
    mock.timers.tick(10_000)
    await cache.get('e', source.load)
    await cache.get('f', source.load) // full again, everything has expired: only the expired go
    assert.equal(await cache.get('f', source.load), 7)
  })

  it('forgets everything on clear', async () => {
    const cache = createTtlCache<number>(10_000, 10)
    const source = counting()
    await cache.get('a', source.load)
    cache.clear()
    assert.equal(await cache.get('a', source.load), 2)
  })
})
