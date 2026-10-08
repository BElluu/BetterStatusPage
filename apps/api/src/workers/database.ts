import type { MonitorStatus, DatabaseConfig, VaultRef } from '@bsp/shared'
import { resolveVaultSecret } from './resolveSecret.js'

/** Where to connect: a full connection string, or discrete settings. */
export type DatabaseConnection =
  | { connectionString: string }
  | { host: string; port: number; database: string; user: string; password: string }

/** One open connection (or pool) owned by a single check. */
export interface DatabaseSession {
  /** Rows as value arrays, so the first column is `row[0]` whatever its name. */
  query(sql: string): Promise<unknown[][]>
  /** Never throws: the check result is already decided by the time it runs. */
  close(): Promise<void>
}

/** Everything that differs between database engines. The check and test flows are shared. */
export interface DatabaseDriver {
  /** Engine name used in error messages, e.g. 'SQL Server'. */
  label: string
  defaultQuery: string
  /** A dedicated connection per call: monitors must never share state through a driver-wide pool. */
  connect(connection: DatabaseConnection, timeoutMs: number): Promise<DatabaseSession>
}

export type DatabaseCheckResult = { status: MonitorStatus; responseMs: number | null; error: string | null }

export async function resolveConnectionString(driver: DatabaseDriver, vault: VaultRef): Promise<string> {
  const creds = await resolveVaultSecret(vault)
  const connectionString = creds['connectionString'] ?? creds['value'] ?? ''
  if (!connectionString) throw new Error(`${driver.label}: resolved connection string is empty`)
  return connectionString
}

export async function resolveFieldCredentials(config: DatabaseConfig): Promise<{ user: string; password: string }> {
  let { user, password } = config
  if (config.vault) {
    const creds = await resolveVaultSecret(config.vault)
    user     = creds['username'] ?? creds['user']  ?? user
    password = creds['password'] ?? creds['value'] ?? password
  }
  return { user, password }
}

/** The first column of the first row as text, or null for an empty result. */
export function firstValue(rows: unknown[][]): string | null {
  return rows.length > 0 ? String(rows[0]![0]) : null
}

export async function checkDatabase(driver: DatabaseDriver, config: DatabaseConfig, timeoutMs: number): Promise<DatabaseCheckResult> {
  const start = Date.now()
  let session: DatabaseSession | null = null
  try {
    let connection: DatabaseConnection
    if (config.mode === 'connectionString') {
      if (!config.vault) throw new Error(`${driver.label} connection string mode requires a vault secret`)
      connection = { connectionString: await resolveConnectionString(driver, config.vault) }
    } else {
      const { user, password } = await resolveFieldCredentials(config)
      connection = { host: config.host, port: config.port, database: config.database, user, password }
    }

    session = await driver.connect(connection, timeoutMs)
    const rows = await session.query(config.query || driver.defaultQuery)
    const responseMs = Date.now() - start

    if (config.expectedResult) {
      const value = firstValue(rows) ?? ''
      if (value !== config.expectedResult) {
        return { status: 'degraded', responseMs, error: `Expected "${config.expectedResult}", got "${value}"` }
      }
    }
    return { status: 'up', responseMs, error: null }
  } catch (err) {
    return { status: 'down', responseMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await session?.close()
  }
}
