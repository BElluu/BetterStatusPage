import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getSseLimits } from '../src/config/sse.js'

describe('event stream limits configuration', () => {
  it('defaults to 1000 streams in total and 10 per address', () => {
    assert.deepEqual(getSseLimits({}), { maxClients: 1000, maxClientsPerIp: 10 })
  })

  it('reads the environment overrides', () => {
    assert.deepEqual(getSseLimits({ SSE_MAX_CLIENTS: '5000', SSE_MAX_CLIENTS_PER_IP: '30' }), { maxClients: 5000, maxClientsPerIp: 30 })
  })

  it('rejects values that are not positive integers', () => {
    assert.throws(() => getSseLimits({ SSE_MAX_CLIENTS: '0' }), /SSE_MAX_CLIENTS must be a positive integer/)
    assert.throws(() => getSseLimits({ SSE_MAX_CLIENTS_PER_IP: 'many' }), /SSE_MAX_CLIENTS_PER_IP/)
  })
})
