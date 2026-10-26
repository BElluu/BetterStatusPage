import { AsyncLocalStorage } from 'node:async_hooks'
import type { DatabaseSync } from 'node:sqlite'

// Transactions of one connection take turns: the next one begins when the previous one has committed or rolled back.
const queues = new WeakMap<DatabaseSync, Promise<unknown>>()
// The connection whose transaction the current async chain is inside, to refuse a nested one.
const inside = new AsyncLocalStorage<DatabaseSync>()

/**
 * Runs `work` between BEGIN IMMEDIATE and COMMIT (or ROLLBACK if it throws).
 *
 * There is one SQLite connection, so a second transaction cannot begin while another is open. Callers that arrive
 * meanwhile wait their turn instead of failing. A transaction started from inside `work` can never get its turn, so
 * it throws.
 *
 * The `await`s inside `work` only yield to microtasks as long as every database call is synchronous underneath, which
 * holds for the node:sqlite driver: no other request can run its statements inside this transaction. Do not await real
 * I/O here (a network call, a timer): that lets another request's writes join the transaction and be rolled back with it.
 */
export function withImmediateTransaction<T>(sqlite: DatabaseSync, work: () => Promise<T>): Promise<T> {
  if (inside.getStore() === sqlite) return Promise.reject(new Error('Nested transaction: it would wait for the one it is part of'))
  const run = (queues.get(sqlite) ?? Promise.resolve()).then(() => runTransaction(sqlite, work))
  queues.set(sqlite, run.catch(() => undefined))
  return run
}

async function runTransaction<T>(sqlite: DatabaseSync, work: () => Promise<T>): Promise<T> {
  sqlite.exec('BEGIN IMMEDIATE')
  try {
    const result = await inside.run(sqlite, work)
    sqlite.exec('COMMIT')
    return result
  } catch (error) {
    try { sqlite.exec('ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  }
}
