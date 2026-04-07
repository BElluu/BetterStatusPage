import type { SqlServerConfig } from '@bsp/shared'
import type { MonitorStatus } from '@bsp/shared'
import { resolveVaultSecret } from './resolveSecret.js'

export async function checkSqlServer(
  config: SqlServerConfig,
  timeoutMs: number,
): Promise<{ status: MonitorStatus; responseMs: number | null; error: string | null }> {
  const start = Date.now()
  let sql: typeof import('mssql') | null = null

  try {
    let user     = config.user
    let password = config.password

    if (config.vault) {
      const creds = await resolveVaultSecret(config.vault)
      user     = creds['username'] ?? creds['user']  ?? user
      password = creds['password'] ?? creds['value'] ?? password
    }

    // Dynamic import to avoid loading mssql if not used
    sql = await import('mssql')
    const pool = await sql.connect({
      server: config.host,
      port: config.port,
      database: config.database,
      user,
      password,
      connectionTimeout: timeoutMs,
      requestTimeout: timeoutMs,
      options: {
        encrypt: true,
        trustServerCertificate: true,
      },
    })

    const result = await pool.request().query(config.query || 'SELECT 1 AS result')
    const responseMs = Date.now() - start

    if (config.expectedResult) {
      const firstRow = result.recordset[0] as Record<string, unknown> | undefined
      const firstValue = firstRow ? String(Object.values(firstRow)[0]) : ''
      if (firstValue !== config.expectedResult) {
        await pool.close()
        return {
          status: 'degraded',
          responseMs,
          error: `Expected "${config.expectedResult}", got "${firstValue}"`,
        }
      }
    }

    await pool.close()
    return { status: 'up', responseMs, error: null }
  } catch (err) {
    const responseMs = Date.now() - start
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 'down', responseMs, error: msg }
  }
}
