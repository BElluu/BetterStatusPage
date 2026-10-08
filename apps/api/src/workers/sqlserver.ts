import type { DatabaseConfig } from '@bsp/shared'
import { checkDatabase, type DatabaseCheckResult, type DatabaseDriver } from './database.js'

export const sqlServerDriver: DatabaseDriver = {
  label: 'SQL Server',
  defaultQuery: 'SELECT 1 AS result',
  async connect(connection, timeoutMs) {
    // mssql is CJS; in an ESM package (.default needed for proper interop)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql = await import('mssql').then((m: any) => m.default ?? m) as typeof import('mssql')
    const target = 'connectionString' in connection
      ? connection.connectionString
      : {
          server: connection.host,
          port: connection.port,
          database: connection.database,
          user: connection.user,
          password: connection.password,
          connectionTimeout: timeoutMs,
          requestTimeout: timeoutMs,
          options: { encrypt: true, trustServerCertificate: true },
        }
    // A dedicated pool per check: mssql's `sql.connect()` hands back one process-wide pool whatever
    // config it is given, so every SQL Server monitor would silently query whichever server
    // connected first. A pool whose connect() rejects holds no connections, so nothing is left to close.
    const pool = await new sql.ConnectionPool(target as string).connect()
    return {
      async query(text) {
        const result = await pool.request().query(text)
        return (result.recordset ?? []).map((row: Record<string, unknown>) => Object.values(row))
      },
      async close() {
        try { await pool.close() } catch { /* the check result is already decided */ }
      },
    }
  },
}

export const checkSqlServer = (config: DatabaseConfig, timeoutMs: number): Promise<DatabaseCheckResult> =>
  checkDatabase(sqlServerDriver, config, timeoutMs)
