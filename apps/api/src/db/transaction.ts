import { sqlite } from './client.js'

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
