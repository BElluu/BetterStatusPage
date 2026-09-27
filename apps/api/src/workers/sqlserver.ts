import type { SqlServerConfig } from '@bsp/shared'
import type { MonitorStatus } from '@bsp/shared'
import type { ConnectionPool, config as MssqlConfig } from 'mssql'
import { resolveVaultSecret } from './resolveSecret.js'

/** What a pool is opened with: a connection string, or discrete connection settings. */
export type SqlServerTarget = string | MssqlConfig

export function sqlServerTarget(config: SqlServerConfig, user: string, password: string, timeoutMs: number): MssqlConfig {
  return {
    server: config.host,
    port: config.port,
    database: config.database,
    user,
    password,
    connectionTimeout: timeoutMs,
    requestTimeout: timeoutMs,
    options: { encrypt: true, trustServerCertificate: true },
  }
}

/**
 * Opens a dedicated pool for one check. mssql's `sql.connect()` hands back a single process-wide
 * pool whatever config it is given, so every SQL Server monitor would silently query whichever
 * server connected first. The caller owns the pool and must close it.
 */
export async function openSqlServerPool(target: SqlServerTarget): Promise<ConnectionPool> {
  // mssql is CJS; in an ESM package (.default needed for proper interop)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql = await import('mssql').then((m: any) => m.default ?? m) as typeof import('mssql')
  // A pool whose connect() rejects holds no connections, so there is nothing left to close.
  return new sql.ConnectionPool(target).connect()
}

export async function closeSqlServerPool(pool: ConnectionPool | null): Promise<void> {
  if (!pool) return
  try { await pool.close() } catch { /* the check result is already decided */ }
}

export async function checkSqlServer(
  config: SqlServerConfig,
  timeoutMs: number,
): Promise<{ status: MonitorStatus; responseMs: number | null; error: string | null }> {
  const start = Date.now()
  let pool: ConnectionPool | null = null
  try {
    let target: SqlServerTarget
    if (config.mode === 'connectionString') {
      if (!config.vault) throw new Error('SQL Server connection string mode requires a vault secret')
      const creds = await resolveVaultSecret(config.vault)
      const connStr = creds['connectionString'] ?? creds['value'] ?? ''
      if (!connStr) throw new Error('SQL Server: resolved connection string is empty')
      target = connStr
    } else {
      let user     = config.user
      let password = config.password
      if (config.vault) {
        const creds = await resolveVaultSecret(config.vault)
        user     = creds['username'] ?? creds['user']  ?? user
        password = creds['password'] ?? creds['value'] ?? password
      }
      target = sqlServerTarget(config, user, password, timeoutMs)
    }

    pool = await openSqlServerPool(target)
    const result = await pool.request().query(config.query || 'SELECT 1 AS result')
    const responseMs = Date.now() - start

    if (config.expectedResult) {
      const firstRow = result.recordset[0] as Record<string, unknown> | undefined
      const firstValue = firstRow ? String(Object.values(firstRow)[0]) : ''
      if (firstValue !== config.expectedResult) {
        return {
          status: 'degraded',
          responseMs,
          error: `Expected "${config.expectedResult}", got "${firstValue}"`,
        }
      }
    }

    return { status: 'up', responseMs, error: null }
  } catch (err) {
    const responseMs = Date.now() - start
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 'down', responseMs, error: msg }
  } finally {
    await closeSqlServerPool(pool)
  }
}
