import type { DatabaseConfig } from '@bsp/shared'
import { checkDatabase, type DatabaseCheckResult, type DatabaseConnection, type DatabaseDriver } from './database.js'

const NO_SSL_MESSAGE = 'The server does not support SSL connections'

export const postgresDriver: DatabaseDriver = {
  label: 'PostgreSQL',
  defaultQuery: 'SELECT 1 AS result',
  async connect(connection, timeoutMs) {
    // pg is CJS; in an ESM package (.default needed for proper interop)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pg = await import('pg').then((m: any) => m.default ?? m) as typeof import('pg')

    const open = async (ssl: boolean) => {
      const client = new pg.Client({
        ...clientTarget(connection, ssl),
        connectionTimeoutMillis: timeoutMs,
        query_timeout: timeoutMs,
      })
      // A server dropping an idle connection emits 'error'; unhandled, it would crash the process.
      client.on('error', () => { /* surfaced by the pending query, if any */ })
      await client.connect()
      return client
    }

    // Discrete fields prefer an encrypted connection (certificate unchecked) and fall back to plain
    // when the server answers that it has no TLS. A connection string carries its own sslmode.
    let client: Awaited<ReturnType<typeof open>>
    try {
      client = await open(true)
    } catch (err) {
      if (!(err instanceof Error) || err.message !== NO_SSL_MESSAGE || 'connectionString' in connection) throw err
      client = await open(false)
    }
    return {
      async query(text) {
        const result = await client.query({ text, rowMode: 'array' })
        return result.rows as unknown[][]
      },
      async close() {
        try { await client.end() } catch { /* the check result is already decided */ }
      },
    }
  },
}

function clientTarget(connection: DatabaseConnection, ssl: boolean) {
  if ('connectionString' in connection) return { connectionString: connection.connectionString }
  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    ssl: ssl ? { rejectUnauthorized: false } : false,
  }
}

export const checkPostgres = (config: DatabaseConfig, timeoutMs: number): Promise<DatabaseCheckResult> =>
  checkDatabase(postgresDriver, config, timeoutMs)
