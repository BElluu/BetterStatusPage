import type { DatabaseConfig } from '@bsp/shared'
import { checkDatabase, type DatabaseCheckResult, type DatabaseDriver } from './database.js'

/** A MongoDB "query" is a database command written as a JSON object, e.g. `{"ping":1}`. */
function parseCommand(text: string): Record<string, unknown> {
  let command: unknown
  try {
    command = JSON.parse(text)
  } catch {
    throw new Error('MongoDB command must be a JSON object, e.g. {"ping":1}')
  }
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('MongoDB command must be a JSON object, e.g. {"ping":1}')
  }
  return command as Record<string, unknown>
}

export const mongoDriver: DatabaseDriver = {
  label: 'MongoDB',
  defaultQuery: '{"ping":1}',
  async connect(connection, timeoutMs) {
    const { MongoClient } = await import('mongodb')
    const timeouts = { serverSelectionTimeoutMS: timeoutMs, connectTimeoutMS: timeoutMs, socketTimeoutMS: timeoutMs }
    // Discrete fields connect without TLS and authenticate against the database (admin when empty), like
    // the driver's own default. A connection string carries its own tls and authSource settings.
    const client = 'connectionString' in connection
      ? new MongoClient(connection.connectionString, timeouts)
      : new MongoClient(`mongodb://${connection.host}:${connection.port}`, {
          ...timeouts,
          ...(connection.user ? { auth: { username: connection.user, password: connection.password }, authSource: connection.database || 'admin' } : {}),
        })
    try {
      await client.connect()
    } catch (err) {
      await client.close().catch(() => undefined)
      throw err
    }
    const db = client.db('connectionString' in connection ? undefined : connection.database || 'admin')
    return {
      async query(text) {
        const result = await db.command(parseCommand(text))
        // One row: the first field of the reply, so `expectedResult` compares it like a SQL first column.
        return [[Object.values(result)[0]]]
      },
      async close() {
        try { await client.close() } catch { /* the check result is already decided */ }
      },
    }
  },
}

export const checkMongo = (config: DatabaseConfig, timeoutMs: number): Promise<DatabaseCheckResult> =>
  checkDatabase(mongoDriver, config, timeoutMs)
