import type { HttpsConfig, SqlServerConfig, PingConfig, DnsConfig } from '@bsp/shared'
import { resolveVaultSecret } from './resolveSecret.js'
import net from 'net'
import { Resolver } from 'dns/promises'

export interface TestStep {
  label: string
  status: 'ok' | 'error' | 'info'
  detail?: string | undefined
  /** Full content for steps where detail is truncated (e.g. body preview) */
  /** Cookie jar snapshot at this point (name → value), for diagnostic downloads */
  cookies?: Record<string, string> | undefined
  durationMs?: number | undefined
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
  const probeCookies = new Map<string, string>()
  let casServerBaseUrl: string | null = null
  let casTgtUrl: string | null = null

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
      casServerBaseUrl = casServerUrl
      casTgtUrl = tgtUrl
      steps.push({ label: `CAS: TGT obtained from ${casServerUrl}`, status: 'ok', durationMs: Date.now() - t1 })
    } catch (err) {
      steps.push({ label: 'CAS: TGT request failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t1 })
      return { overall: 'error', steps, totalMs: Date.now() - totalStart }
    }

    // Probe: follow the redirect chain manually, collecting session cookies at each hop.
    // The ticket must be validated within the same session the app created during this probe.
    let effectiveServiceUrl = config.url
    const tProbe = Date.now()
    try {
      let nextUrl = config.url
      for (let hops = 0; hops < 10; hops++) {
        const cookieHeader = [...probeCookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
        const r = await fetch(nextUrl, {
          redirect: 'manual',
          ...(cookieHeader ? { headers: { Cookie: cookieHeader } } : {}),
          signal: AbortSignal.timeout(5000),
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const setCookies: string[] = (r.headers as any).getSetCookie?.() ?? []
        const newCookieNames: string[] = []
        for (const c of setCookies) {
          const kv = c.split(';')[0]?.trim() ?? ''
          const eq = kv.indexOf('=')
          if (eq > 0) {
            probeCookies.set(kv.substring(0, eq), kv.substring(eq + 1))
            newCookieNames.push(kv.substring(0, eq))
          }
        }
        const jarSnap = newCookieNames.length > 0 ? Object.fromEntries(newCookieNames.map(n => [n, '[redacted]'])) : undefined
        const cookieDetail = newCookieNames.length > 0 ? `Set-Cookie: ${newCookieNames.join(', ')}` : undefined
        if (r.status < 300 || r.status >= 400) {
          steps.push({ label: `CAS probe hop ${hops + 1}: ${r.status} ${nextUrl}`, status: 'info', detail: cookieDetail, cookies: jarSnap })
          break
        }
        const location = r.headers.get('location')
        steps.push({ label: `CAS probe hop ${hops + 1}: ${r.status} ${nextUrl} → ${location ?? '(no location)'}`, status: 'info', detail: cookieDetail, cookies: jarSnap })
        if (!location) break
        const resolved = new URL(location, nextUrl)
        const service = resolved.searchParams.get('service')
        if (service) {
          effectiveServiceUrl = service
          steps.push({ label: 'CAS: effective service URL discovered', status: 'info', detail: effectiveServiceUrl, durationMs: Date.now() - tProbe })
          break
        }
        nextUrl = resolved.toString()
      }
      if (effectiveServiceUrl === config.url) {
        steps.push({ label: 'CAS: probe — no service param found, using original URL', status: 'info', durationMs: Date.now() - tProbe })
      }
      steps.push({
        label: `CAS probe: ${probeCookies.size} session cookie(s) collected`,
        status: 'info',
        detail: probeCookies.size > 0 ? [...probeCookies.keys()].join(', ') : 'none',
      })
    } catch (e) {
      steps.push({ label: 'CAS: probe failed, using original URL', status: 'info', detail: errMsg(e), durationMs: Date.now() - tProbe })
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
      steps.push({ label: 'CAS: submitting ticket to', status: 'info', detail: finalUrl })
    } catch (err) {
      steps.push({ label: 'CAS: service ticket request failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t2 })
      return { overall: 'error', steps, totalMs: Date.now() - totalStart }
    }
  }

  // ── HTTP request ──────────────────────────────────────────────────────────
  const t = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const jar = new Map<string, string>(probeCookies)

    function collectCookies(res: Response): string[] {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const setCookies: string[] = (res.headers as any).getSetCookie?.() ?? []
      const names: string[] = []
      for (const c of setCookies) {
        const kv = c.split(';')[0]?.trim() ?? ''
        const eq = kv.indexOf('=')
        if (eq > 0) { jar.set(kv.substring(0, eq), kv.substring(eq + 1)); names.push(kv.substring(0, eq)) }
      }
      return names
    }

    function cookieHdr(): Record<string, string> {
      const h = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
      return h ? { Cookie: h } : {}
    }

    // ── Phase 1 (CAS only): RegisterServiceTicket ────────────────────────
    // Single GET to {serviceUrl}?ticket={st} — nginx validates the ticket and
    // responds with Set-Cookie: NGXCAS (and possibly SL_Session).
    // We do NOT follow the redirect further; we just need the cookies.
    let res!: Response
    if (casServerBaseUrl) {
      const tTicket = Date.now()
      res = await fetch(finalUrl, {
        method: 'GET',
        headers: { ...cookieHdr() },
        signal: controller.signal,
        redirect: 'manual',
      })
      collectCookies(res)
      steps.push({
        label: `CAS: ticket registered → ${res.status}`,
        status: 'ok',
        detail: `Cookies collected: ${[...jar.keys()].join(', ')}`,
        cookies: Object.fromEntries([...jar.keys()].map((name) => [name, '[redacted]'])),
        durationMs: Date.now() - tTicket,
      })
    }

    // ── Phase 2: visit the monitored URL with all auth cookies ────────────
    // NGXCAS is now set, so NGINX will let requests through.
    // If the app has its own CAS layer, it will redirect to CAS login.
    // We intercept that redirect and get a fresh ticket — this time NGINX passes
    // the ticket through to the app (NGXCAS is valid), so the app can validate
    // it and establish its own authenticated session.
    steps.push({ label: `GET ${config.url}`, status: 'info' })
    let currentUrl2 = config.url
    for (let hops = 0; hops < 10; hops++) {
      res = await fetch(currentUrl2, {
        method: config.method ?? 'GET',
        headers: { ...(config.headers ?? {}), ...authHeaders, ...cookieHdr() },
        ...(config.body !== undefined ? { body: config.body } : {}),
        signal: controller.signal,
        redirect: 'manual',
      })
      const newCookies = collectCookies(res)
      const newJarSnap = newCookies.length ? Object.fromEntries(newCookies.map(n => [n, '[redacted]'])) : undefined
      const cookieNote = newCookies.length ? ` [Set-Cookie: ${newCookies.join(', ')}]` : ''
      if (res.status < 300 || res.status >= 400) break
      const loc = res.headers.get('location')
      if (!loc) break
      const next = new URL(loc, currentUrl2).toString()

      // CAS redirect from app-level auth → get a new ticket and submit it directly.
      // NGINX has NGXCAS so it won't interfere; the app will receive the ticket.
      if (casTgtUrl && casServerBaseUrl && next.startsWith(`${casServerBaseUrl}/login`)) {
        const svc = new URL(next).searchParams.get('service')
        if (svc) {
          const tInt = Date.now()
          try {
            const stRes2 = await fetch(casTgtUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ service: svc }).toString(),
            })
            if (!stRes2.ok) throw new Error(`HTTP ${stRes2.status}`)
            const ticket2 = (await stRes2.text()).trim()
            const u2 = new URL(svc)
            u2.searchParams.set('ticket', ticket2)
            steps.push({ label: `CAS: app-level ticket obtained${cookieNote}`, status: 'info', detail: '[redacted]', cookies: newJarSnap, durationMs: Date.now() - tInt })
            currentUrl2 = u2.toString()
            continue
          } catch (err2) {
            steps.push({ label: 'CAS: app-level ticket request failed', status: 'error', detail: errMsg(err2) })
            break
          }
        }
      }

      steps.push({ label: `→ ${res.status} ${next}${cookieNote}`, status: 'info', cookies: newJarSnap })
      currentUrl2 = next
    }

    clearTimeout(timer)
    const responseMs = Date.now() - t

    const expectedStatus = config.expectedStatus ?? 200
    if (res.status !== expectedStatus) {
      steps.push({ label: `Response: HTTP ${res.status}`, status: 'error', detail: `Expected HTTP ${expectedStatus}`, durationMs: responseMs })
      return { overall: 'error', steps, totalMs: Date.now() - totalStart }
    }
    steps.push({ label: `Response: HTTP ${res.status}`, status: 'ok', durationMs: responseMs })

    // Keep the body in memory for validation, but never expose it in diagnostics.
    const body = await res.text()
    steps.push({ label: 'Response body', status: 'info', detail: `${Buffer.byteLength(body, 'utf8')} bytes (content omitted)` })

    // ── Keyword check ───────────────────────────────────────────────────
    if (config.keyword) {
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

// ── Ping (TCP) ────────────────────────────────────────────────────────────────

export async function testPing(config: PingConfig, timeoutMs: number): Promise<TestResult> {
  const steps: TestStep[] = []
  const totalStart = Date.now()
  const port = config.port ?? 80
  const t = Date.now()
  try {
    const responseMs = await new Promise<number>((resolve, reject) => {
      const socket = new net.Socket()
      socket.setTimeout(timeoutMs)
      socket.on('connect', () => { resolve(Date.now() - t); socket.destroy() })
      socket.on('timeout', () => { socket.destroy(); reject(new Error('TCP connect timed out')) })
      socket.on('error', reject)
      socket.connect(port, config.host)
    })
    steps.push({ label: `TCP connect to ${config.host}:${port}`, status: 'ok', durationMs: responseMs })
    return { overall: 'ok', steps, totalMs: Date.now() - totalStart }
  } catch (err) {
    steps.push({ label: `TCP connect to ${config.host}:${port} failed`, status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
    return { overall: 'error', steps, totalMs: Date.now() - totalStart }
  }
}

// ── DNS ───────────────────────────────────────────────────────────────────────

export async function testDns(config: DnsConfig, timeoutMs: number): Promise<TestResult> {
  const steps: TestStep[] = []
  const totalStart = Date.now()
  const resolver = new Resolver()
  if (config.resolver) {
    resolver.setServers([config.resolver])
    steps.push({ label: `Custom resolver: ${config.resolver}`, status: 'info' })
  }
  const t = Date.now()
  try {
    const records: string[] = await Promise.race([
      (async () => {
        switch (config.recordType) {
          case 'A':     return resolver.resolve4(config.hostname)
          case 'AAAA':  return resolver.resolve6(config.hostname)
          case 'MX':    return (await resolver.resolveMx(config.hostname)).map(r => r.exchange)
          case 'CNAME': return resolver.resolveCname(config.hostname)
          case 'TXT':   return (await resolver.resolveTxt(config.hostname)).map(r => r.join(''))
          default:      return resolver.resolve(config.hostname)
        }
      })(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS query timed out')), timeoutMs)),
    ])
    const responseMs = Date.now() - t
    steps.push({ label: `DNS ${config.recordType} for ${config.hostname}`, status: 'ok', detail: records.join(', '), durationMs: responseMs })
    if (config.expectedValue) {
      if (records.some(r => r.includes(config.expectedValue!))) {
        steps.push({ label: `Expected value "${config.expectedValue}" found`, status: 'ok' })
      } else {
        steps.push({ label: `Expected value "${config.expectedValue}" not found`, status: 'error', detail: `Got: ${records.join(', ')}` })
        return { overall: 'error', steps, totalMs: Date.now() - totalStart }
      }
    }
    return { overall: 'ok', steps, totalMs: Date.now() - totalStart }
  } catch (err) {
    steps.push({ label: `DNS ${config.recordType} query for ${config.hostname} failed`, status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
    return { overall: 'error', steps, totalMs: Date.now() - totalStart }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
