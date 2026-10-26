import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { safeLocalStorage } from '@better-kit/contracts'

const blocked = {
  get() { throw new DOMException('denied', 'SecurityError') },
}

describe('safeLocalStorage', () => {
  afterEach(() => { Reflect.deleteProperty(globalThis, 'localStorage') })

  it('reads empty and ignores writes when the browser blocks storage', () => {
    Object.defineProperty(globalThis, 'localStorage', { ...blocked, configurable: true })
    assert.equal(safeLocalStorage.get('k'), null)
    assert.doesNotThrow(() => safeLocalStorage.set('k', 'v'))
    assert.doesNotThrow(() => safeLocalStorage.remove('k'))
  })

  it('reads and writes through when storage works', () => {
    const data = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) },
      configurable: true,
    })
    safeLocalStorage.set('k', 'v')
    assert.equal(safeLocalStorage.get('k'), 'v')
    safeLocalStorage.remove('k')
    assert.equal(safeLocalStorage.get('k'), null)
  })
})
