import type { DatabaseConfig } from '@bsp/shared'
import { checkDatabase, type DatabaseCheckResult, type DatabaseDriver } from './database.js'

/** Serves MySQL and MariaDB: mysql2 speaks the protocol of both. */
export const mysqlDriver: DatabaseDriver = {
  label: 'MySQL / MariaDB',
  defaultQuery: 'SELECT 1 AS result',
  async connect(connection, timeoutMs) {
    const mysql = await import('mysql2/promise')

    const open = (ssl: boolean) => mysql.createConnection(
      'connectionString' in connection
        ? { uri: connection.connectionString, connectTimeout: timeoutMs }
        : {
            host: connection.host,
            port: connection.port,
            database: connection.database,
            user: connection.user,
            password: connection.password,
            connectTimeout: timeoutMs,
            ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
          },
    )

    // Discrete fields prefer an encrypted connection (certificate unchecked) and fall back to plain
    // when the server has no TLS. A connection string carries its own ssl settings.
    let conn: Awaited<ReturnType<typeof open>>
    try {
      conn = await open(true)
    } catch (err) {
      const noTls = (err as { code?: string }).code === 'HANDSHAKE_NO_SSL_SUPPORT'
      if (!noTls || 'connectionString' in connection) throw err
      conn = await open(false)
    }
    // A server dropping an idle connection emits 'error'; unhandled, it would crash the process.
    conn.on('error', () => { /* surfaced by the pending query, if any */ })
    return {
      async query(text) {
        const [rows] = await conn.query({ sql: text, rowsAsArray: true, timeout: timeoutMs })
        return Array.isArray(rows) ? (rows as unknown[][]) : []
      },
      async close() {
        // destroy(), not end(): after a query timeout end() queues behind the still-running query and can wait forever,
        // which would keep the monitor 'in flight' and never check it again.
        conn.destroy()
      },
    }
  },
}

export const checkMysql = (config: DatabaseConfig, timeoutMs: number): Promise<DatabaseCheckResult> =>
  checkDatabase(mysqlDriver, config, timeoutMs)
