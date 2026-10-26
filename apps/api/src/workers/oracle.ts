import type { DatabaseConfig } from '@bsp/shared'
import { checkDatabase, type DatabaseCheckResult, type DatabaseConnection, type DatabaseDriver } from './database.js'

/** What `connectionString` mode holds for Oracle: `user/password@connect_string`, as sqlplus takes it. */
export function parseOracleLogin(text: string): { user: string; password: string; connectString: string } {
  const match = /^([^/@\s]+)\/([^@]*)@(.+)$/s.exec(text.trim())
  if (!match) throw new Error('Oracle connection string must look like user/password@host:port/service_name')
  return { user: match[1]!, password: match[2]!, connectString: match[3]! }
}

/** The Easy Connect string of a fields-mode connection; `tcps` only when the connection is encrypted. */
export const oracleConnectString = (c: Extract<DatabaseConnection, { host: string }>): string =>
  `${c.tls === 'verify' ? 'tcps://' : ''}${c.host}:${c.port}/${c.database}`

/**
 * Oracle's thin driver (pure JavaScript, no Oracle Client needed) always checks the server certificate, so there is no
 * "encrypted but not checked" mode: `prefer` connects without encryption, as MongoDB monitors do, `verify` uses TLS.
 */
export const oracleDriver: DatabaseDriver = {
  label: 'Oracle',
  defaultQuery: 'SELECT 1 FROM DUAL',
  async connect(connection, timeoutMs) {
    const { default: oracledb } = await import('oracledb')
    const login = 'connectionString' in connection
      ? parseOracleLogin(connection.connectionString)
      : { user: connection.user, password: connection.password, connectString: oracleConnectString(connection) }
    if (!('connectionString' in connection) && connection.tls === 'require') {
      throw new Error('Oracle cannot encrypt without checking the certificate: choose "Encrypted, verify certificate", or "Encrypted if available" for an unencrypted connection')
    }
    const ca = !('connectionString' in connection) && connection.tls === 'verify' ? connection.ca : undefined

    const conn = await oracledb.getConnection({
      user: login.user,
      password: login.password,
      connectString: login.connectString,
      // Seconds; without them a host that drops packets would hold the check until the OS gives up.
      transportConnectTimeout: Math.ceil(timeoutMs / 1000),
      ...(ca ? { walletContent: ca } : {}),
    })
    conn.callTimeout = timeoutMs
    return {
      async query(text) {
        const result = await conn.execute(text, [], { outFormat: oracledb.OUT_FORMAT_ARRAY })
        return (result.rows ?? []) as unknown[][]
      },
      async close() {
        // A timed-out call leaves the session busy; close() would wait for it, so it is dropped on a short leash.
        await Promise.race([conn.close(), new Promise((resolve) => setTimeout(resolve, 2_000).unref())]).catch(() => {})
      },
    }
  },
}

export const checkOracle = (config: DatabaseConfig, timeoutMs: number): Promise<DatabaseCheckResult> =>
  checkDatabase(oracleDriver, config, timeoutMs)
