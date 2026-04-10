import type { HttpsConfig, SqlServerConfig } from '@bsp/shared'
import { resolveVaultSecret } from './resolveSecret.js'

export interface TestStep {
  label: string
  status: 'ok' | 'error' | 'info'
  detail?: string
  durationMs?: number
}

export interface TestResult {
  overall: 'ok' | 'error'
  steps: TestStep[]
  totalMs: number
}

// ── HTTPS ─────────────────────────────────────────────────────────────────────

export async function testHttps(config: HttpsConfig, timeoutMs: number): Promise<TestResult> {
  const steps: TestStep[] = []
  const totalStart = Date.now()

  let authHeaders: Record<string, string> = {}
  let finalUrl = config.url

  const auth = config.auth

  // ── Auth resolution ─────────────────────────────────────────────────────
  if (!auth || auth.type === 'none') {
    steps.push({ label: 'Authorization: none', status: 'info' })

  } else if (auth.type === 'basic') {
    const cfg = auth.basic ?? { username: '', password: '' }
    const t = Date.now()
    try {
      let username = cfg.username ?? ''
      let password = cfg.password ?? ''
      if (cfg.vault) {
        const creds = await resolveVaultSecret(cfg.vault)
        username = creds['username'] ?? username
        password = creds['password'] ?? creds['value'] ?? password
      }
      const encoded = Buffer.from(`${username}:${password}`).toString('base64')
      authHeaders = { Authorization: `Basic ${encoded}` }
      steps.push({
        label: cfg.vault ? 'Basic Auth: credentials resolved from Vault' : 'Basic Auth: using direct credentials',
        status: 'ok',
        detail: `User: ${username}`,
        durationMs: cfg.vault ? Date.now() - t : undefined,
      })
    } catch (err) {
      steps.push({ label: 'Basic Auth: failed to resolve credentials', status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
      return { overall: 'error', steps, totalMs: Date.now() - totalStart }
    }

  } else if (auth.type === 'oauth2') {
    const cfg = auth.oauth2 ?? { tokenUrl: '', clientId: '', clientSecret: '' }
    let clientId     = cfg.clientId ?? ''
    let clientSecret = cfg.clientSecret ?? ''

    if (cfg.vault) {
      const t = Date.now()
      try {
        const creds = await resolveVaultSecret(cfg.vault)
        clientId     = creds['clientId']     ?? creds['username'] ?? clientId
        clientSecret = creds['clientSecret'] ?? creds['password'] ?? creds['value'] ?? clientSecret
        steps.push({ label: 'OAuth2: credentials resolved from Vault', status: 'ok', detail: `Client ID: ${clientId}`, durationMs: Date.now() - t })
      } catch (err) {
        steps.push({ label: 'OAuth2: Vault resolution failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
        return { overall: 'error', steps, totalMs: Date.now() - totalStart }
      }
    }

    const tokenUrl = cfg.tokenUrl ?? ''
    if (!tokenUrl) {
      steps.push({ label: 'OAuth2: Token URL is missing', status: 'error' })
      return { overall: 'error', steps, totalMs: Date.now() - totalStart }
    }

    const t = Date.now()
    try {
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      })
      if (cfg.scope) params.set('scope', cfg.scope)
      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      })
      if (!tokenRes.ok) throw new Error(`HTTP ${tokenRes.status} ${tokenRes.statusText}`)
      const tokenData = await tokenRes.json() as { access_token?: string; expires_in?: number; token_type?: string }
      if (!tokenData.access_token) throw new Error('Response missing access_token')
      authHeaders = { Authorization: `Bearer ${tokenData.access_token}` }
      const meta = [
        tokenData.token_type ?? 'Bearer',
        tokenData.expires_in != null ? `expires in ${tokenData.expires_in}s` : null,
      ].filter(Boolean).join(', ')
      steps.push({ label: `OAuth2: token obtained from ${tokenUrl}`, status: 'ok', detail: meta, durationMs: Date.now() - t })
    } catch (err) {
      steps.push({ label: `OAuth2: token request to ${tokenUrl} failed`, status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
      return { overall: 'error', steps, totalMs: Date.now() - totalStart }
    }

  } else if (auth.type === 'cas') {
    const cfg = auth.cas ?? { casServerUrl: '', username: '', password: '' }
    const casServerUrl = cfg.casServerUrl ?? ''
    let username = cfg.username ?? ''
    let password = cfg.password ?? ''

    if (cfg.vault) {
      const t = Date.now()
      try {
        const creds = await resolveVaultSecret(cfg.vault)
        username = creds['username'] ?? username
        password = creds['password'] ?? creds['value'] ?? password
        steps.push({ label: 'CAS: credentials resolved from Vault', status: 'ok', durationMs: Date.now() - t })
      } catch (err) {
        steps.push({ label: 'CAS: Vault resolution failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
        return { overall: 'error', steps, totalMs: Date.now() - totalStart }
      }
    }
    if (!casServerUrl) {
      steps.push({ label: 'CAS: Server URL is missing', status: 'error' })
      return { overall: 'error', steps, totalMs: Date.now() - totalStart }
    }

    // TGT
    const t1 = Date.now()
    let tgtUrl: string
    try {
      const tgtRes = await fetch(`${casServerUrl}/v1/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password }).toString(),
      })
      if (!tgtRes.ok) throw new Error(`HTTP ${tgtRes.status} ${tgtRes.statusText}`)
      tgtUrl = tgtRes.headers.get('location') ?? ''
      if (!tgtUrl) throw new Error('No Location header in TGT response')
      steps.push({ label: `CAS: TGT obtained from ${casServerUrl}`, status: 'ok', durationMs: Date.now() - t1 })
    } catch (err) {
      steps.push({ label: 'CAS: TGT request failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t1 })
      return { overall: 'error', steps, totalMs: Date.now() - totalStart }
    }

    // Probe: follow the full redirect chain to discover the exact service URL CAS expects.
    // The app may redirect through multiple hops before landing on CAS login with ?service=<url>.
    let effectiveServiceUrl = config.url
    const tProbe = Date.now()
    try {
      const probeRes = await fetch(config.url, { redirect: 'follow', signal: AbortSignal.timeout(5000) })
      // probeRes.url is the final URL after all redirects
      if (probeRes.url && probeRes.url !== config.url) {
        const extracted = new URL(probeRes.url).searchParams.get('service')
        if (extracted) {
          effectiveServiceUrl = extracted
          steps.push({ label: 'CAS: effective service URL discovered', status: 'info', detail: effectiveServiceUrl, durationMs: Date.now() - tProbe })
        } else {
          steps.push({ label: 'CAS: probe — no service param found, using original URL', status: 'info', durationMs: Date.now() - tProbe })
        }
      } else {
        steps.push({ label: 'CAS: probe — no redirect, using original URL', status: 'info', durationMs: Date.now() - tProbe })
      }
    } catch {
      steps.push({ label: 'CAS: probe failed, using original URL', status: 'info', durationMs: Date.now() - tProbe })
    }

    // Service ticket
    const t2 = Date.now()
    try {
      const stRes = await fetch(tgtUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ service: effectiveServiceUrl }).toString(),
      })
      if (!stRes.ok) throw new Error(`HTTP ${stRes.status} ${stRes.statusText}`)
      const ticket = (await stRes.text()).trim()
      const u = new URL(effectiveServiceUrl)
      u.searchParams.set('ticket', ticket)
      finalUrl = u.toString()
      steps.push({ label: 'CAS: service ticket obtained', status: 'ok', detail: `${ticket.substring(0, 24)}…`, durationMs: Date.now() - t2 })
    } catch (err) {
      steps.push({ label: 'CAS: service ticket request failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t2 })
      return { overall: 'error', steps, totalMs: Date.now() - totalStart }
    }
  }

  // ── HTTP request ──────────────────────────────────────────────────────────
  steps.push({ label: `${config.method ?? 'GET'} ${config.url}`, status: 'info' })
  const t = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(finalUrl, {
      method: config.method ?? 'GET',
      headers: { ...(config.headers ?? {}), ...authHeaders },
      signal: controller.signal,
      redirect: 'follow',
    })
    clearTimeout(timer)
    const responseMs = Date.now() - t

    if (res.url !== finalUrl && res.url !== config.url) {
      steps.push({ label: `Redirected → ${res.url}`, status: 'info' })
    }

    const expectedStatus = config.expectedStatus ?? 200
    if (res.status !== expectedStatus) {
      steps.push({ label: `Response: HTTP ${res.status}`, status: 'error', detail: `Expected HTTP ${expectedStatus}`, durationMs: responseMs })
      return { overall: 'error', steps, totalMs: Date.now() - totalStart }
    }
    steps.push({ label: `Response: HTTP ${res.status}`, status: 'ok', durationMs: responseMs })

    // ── Keyword check ───────────────────────────────────────────────────
    if (config.keyword) {
      const body = await res.text()
      if (body.includes(config.keyword)) {
        steps.push({ label: `Keyword "${config.keyword}" found in response`, status: 'ok' })
      } else {
        steps.push({ label: `Keyword "${config.keyword}" not found in response`, status: 'error' })
        return { overall: 'error', steps, totalMs: Date.now() - totalStart }
      }
    }
  } catch (err) {
    steps.push({ label: 'Request failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
    return { overall: 'error', steps, totalMs: Date.now() - totalStart }
  }

  return { overall: 'ok', steps, totalMs: Date.now() - totalStart }
}

// ── SQL Server ────────────────────────────────────────────────────────────────

export async function testSqlServer(config: SqlServerConfig, timeoutMs: number): Promise<TestResult> {
  const steps: TestStep[] = []
  const totalStart = Date.now()

  try {
    // mssql is CJS; in an ESM package (.default needed for proper interop)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql = await import('mssql').then((m: any) => m.default ?? m) as typeof import('mssql')
    let pool: import('mssql').ConnectionPool

    if (config.mode === 'connectionString') {
      if (!config.vault) {
        steps.push({ label: 'Connection string: no Vault secret configured', status: 'error' })
        return { overall: 'error', steps, totalMs: Date.now() - totalStart }
      }
      const t = Date.now()
      let connStr: string
      try {
        const creds = await resolveVaultSecret(config.vault)
        connStr = creds['connectionString'] ?? creds['value'] ?? ''
        if (!connStr) throw new Error('Resolved connection string is empty')
        steps.push({ label: 'Connection string resolved from Vault', status: 'ok', durationMs: Date.now() - t })
      } catch (err) {
        steps.push({ label: 'Vault resolution failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
        return { overall: 'error', steps, totalMs: Date.now() - totalStart }
      }
      const t2 = Date.now()
      try {
        pool = await sql.connect(connStr)
        steps.push({ label: 'Connected via connection string', status: 'ok', durationMs: Date.now() - t2 })
      } catch (err) {
        steps.push({ label: 'Connection failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t2 })
        return { overall: 'error', steps, totalMs: Date.now() - totalStart }
      }
    } else {
      let user     = config.user
      let password = config.password

      if (config.vault) {
        const t = Date.now()
        try {
          const creds = await resolveVaultSecret(config.vault)
          user     = creds['username'] ?? creds['user']  ?? user
          password = creds['password'] ?? creds['value'] ?? password
          steps.push({ label: 'Credentials resolved from Vault', status: 'ok', detail: `User: ${user}`, durationMs: Date.now() - t })
        } catch (err) {
          steps.push({ label: 'Vault resolution failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
          return { overall: 'error', steps, totalMs: Date.now() - totalStart }
        }
      } else {
        steps.push({ label: 'Using direct credentials', status: 'info', detail: `User: ${user}` })
      }

      const t = Date.now()
      try {
        pool = await sql.connect({
          server: config.host, port: config.port, database: config.database,
          user, password,
          connectionTimeout: timeoutMs, requestTimeout: timeoutMs,
          options: { encrypt: true, trustServerCertificate: true },
        })
        steps.push({ label: `Connected to ${config.host}:${config.port} / ${config.database}`, status: 'ok', durationMs: Date.now() - t })
      } catch (err) {
        steps.push({ label: `Connection to ${config.host}:${config.port} failed`, status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
        return { overall: 'error', steps, totalMs: Date.now() - totalStart }
      }
    }

    // ── Query ───────────────────────────────────────────────────────────────
    const query = config.query || 'SELECT 1 AS result'
    const t = Date.now()
    try {
      const result = await pool.request().query(query)
      const responseMs = Date.now() - t
      const firstRow   = result.recordset[0] as Record<string, unknown> | undefined
      const firstValue = firstRow ? String(Object.values(firstRow)[0]) : '(no rows)'
      steps.push({
        label: `Query OK — ${result.recordset.length} row(s) returned`,
        status: 'ok',
        detail: `${query} → ${firstValue}`,
        durationMs: responseMs,
      })

      if (config.expectedResult) {
        if (firstValue === config.expectedResult) {
          steps.push({ label: `Expected result matched: "${config.expectedResult}"`, status: 'ok' })
        } else {
          steps.push({ label: 'Expected result mismatch', status: 'error', detail: `Expected "${config.expectedResult}", got "${firstValue}"` })
          await pool.close()
          return { overall: 'error', steps, totalMs: Date.now() - totalStart }
        }
      }
      await pool.close()
    } catch (err) {
      steps.push({ label: 'Query failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
      try { await pool.close() } catch { /* ignore */ }
      return { overall: 'error', steps, totalMs: Date.now() - totalStart }
    }
  } catch (err) {
    steps.push({ label: 'Test failed', status: 'error', detail: errMsg(err) })
    return { overall: 'error', steps, totalMs: Date.now() - totalStart }
  }

  return { overall: 'ok', steps, totalMs: Date.now() - totalStart }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
