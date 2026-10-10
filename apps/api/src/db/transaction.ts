import { sqlite } from './client.js'

/**
 * Runs `work` between BEGIN IMMEDIATE and COMMIT (or ROLLBACK if it throws).
 *
 * There is one SQLite connection. The `await`s inside `work` only yield to microtasks as long as every database
 * call is synchronous underneath, which holds for the node:sqlite driver: no other request can run its statements
 * inside this transaction. Do not await real I/O here (a network call, a timer): that lets another request's writes
 * join the transaction and be rolled back with it.
 */
export async function withImmediateTransaction<T>(work: () => Promise<T>): Promise<T> {
  sqlite.exec('BEGIN IMMEDIATE')
  try {
    const result = await work()
    sqlite.exec('COMMIT')
    return result
  } catch (error) {
    try { sqlite.exec('ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  }
}
