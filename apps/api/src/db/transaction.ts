import { withImmediateTransaction as inTransaction } from '@better-forge/db'
import { sqlite } from './client.js'

/** Runs `work` in an immediate transaction on the process's connection; see the database package for the rules. */
export function withImmediateTransaction<T>(work: () => Promise<T>): Promise<T> {
  return inTransaction(sqlite, work)
}
