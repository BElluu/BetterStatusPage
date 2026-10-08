import type { HttpsConfig, DatabaseConfig, PingConfig, DnsConfig, DockerConfig } from '@bsp/shared'
import { evaluateContainer, inspectContainer, validateDockerConfig } from './docker.js'
import { CookieJar, discardBody, errMsg, redactedCookies, requestWithCas, resolveHttpAuth, type HttpFetch, type HttpResponse, type ResolvedHttpAuth } from './httpAuth.js'
import { firstValue, resolveConnectionString, resolveFieldCredentials, type DatabaseConnection, type DatabaseDriver, type DatabaseSession } from './database.js'
import { sqlServerDriver } from './sqlserver.js'
import { postgresDriver } from './postgres.js'
import { mysqlDriver } from './mysql.js'
import { mongoDriver } from './mongodb.js'
import { certificateTarget, certMilestone, normalizeCertExpiry, readCertificate } from './certificate.js'
import { expiresInPhrase } from './notifier.js'
import { checkPing } from './ping.js'
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
  const fail = (): TestResult => ({ overall: 'error', steps, totalMs: Date.now() - totalStart })

  // The timeout covers the whole exchange — token/ticket requests, redirects and reading the body —
  // exactly like the scheduled check, and is always cleared.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs)
  const opts = { fetch: globalFetch, signal: controller.signal, onStep: (s: TestStep) => { steps.push(s) } }
  try {
    // ── Auth resolution ─────────────────────────────────────────────────────
    let auth: ResolvedHttpAuth
    try {
      auth = await resolveHttpAuth(config.auth, config.url, opts)
    } catch (err) {
      // Failures inside the auth flow report their own step; anything else still needs one.
      if (steps.at(-1)?.status !== 'error') steps.push({ label: 'Authorization failed', status: 'error', detail: errMsg(err) })
      return fail()
    }

    // ── HTTP request ──────────────────────────────────────────────────────────
    const t = Date.now()
    try {
      const method = (config.method ?? 'GET').toUpperCase()
      steps.push({ label: `${method} ${config.url}`, status: 'info' })
      const res = auth.cas
        ? await requestWithCas(config, { ...auth, cas: auth.cas }, opts)
        : await followRedirects(config, auth.headers, controller.signal, steps)

      const responseMs = Date.now() - t

      const expectedStatus = config.expectedStatus ?? 200
      if (res.status !== expectedStatus) {
        await discardBody(res)
        steps.push({ label: `Response: HTTP ${res.status}`, status: 'error', detail: `Expected HTTP ${expectedStatus}`, durationMs: responseMs })
        return fail()
      }
      steps.push({ label: `Response: HTTP ${res.status}`, status: 'ok', durationMs: responseMs })

      // Keep the body in memory for validation, but never expose it in diagnostics.
      const responseBody = await res.text()
      steps.push({ label: 'Response body', status: 'info', detail: `${Buffer.byteLength(responseBody, 'utf8')} bytes (content omitted)` })

      // ── Keyword check ───────────────────────────────────────────────────
      if (config.keyword) {
        if (responseBody.includes(config.keyword)) {
          steps.push({ label: `Keyword "${config.keyword}" found in response`, status: 'ok' })
        } else {
          steps.push({ label: `Keyword "${config.keyword}" not found in response`, status: 'error' })
          return fail()
        }
      }
    } catch (err) {
      steps.push({ label: 'Request failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
      return fail()
    }
  } finally {
    clearTimeout(timer)
  }

  if (certificateTarget(config.url)) steps.push(await certificateStep(config, timeoutMs))

  return { overall: 'ok', steps, totalMs: Date.now() - totalStart }
}

/** Shows when the endpoint's certificate expires. Informational: the certificate was already accepted above. */
export async function certificateStep(config: HttpsConfig, timeoutMs: number): Promise<TestStep> {
  const t = Date.now()
  try {
    const cert = await readCertificate(config.url, timeoutMs)
    const daysLeft = (cert.expiresAt - Date.now()) / 86_400_000
    const policy = normalizeCertExpiry(config.certExpiry)
    const warning = policy && certMilestone(daysLeft, policy.warnDays) !== null
      ? ` — inside the ${policy.warnDays}-day warning window`
      : ''
    return {
      label: `TLS certificate expires ${expiresInPhrase(daysLeft)}`,
      status: warning ? 'info' : 'ok',
      detail: `${new Date(cert.expiresAt).toISOString()}${cert.issuer ? `, issued by ${cert.issuer}` : ''}${warning}`,
      durationMs: Date.now() - t,
    }
  } catch (err) {
    return { label: 'TLS certificate could not be read', status: 'info', detail: errMsg(err), durationMs: Date.now() - t }
  }
}

const globalFetch: HttpFetch = (url, init) => fetch(url, init)

/**
 * Follows redirects by hand so every hop shows up as a step, while sending exactly what the
 * scheduled check sends: it relies on fetch, which keeps no cookie jar, turns 303 (and 301/302
 * after POST) into a body-less GET, and drops Authorization and Cookie once a redirect leaves the
 * original origin.
 */
async function followRedirects(
  config: HttpsConfig,
  authHeaders: Record<string, string>,
  signal: AbortSignal,
  steps: TestStep[],
): Promise<HttpResponse> {
  let method = (config.method ?? 'GET').toUpperCase()
  let body: string | undefined = config.body
  let sendCredentials = true
  let currentUrl = config.url
  let res!: HttpResponse
  for (let hops = 0; hops < 10; hops++) {
    // The previous hop was a redirect; only the final response keeps its body.
    if (hops > 0) await discardBody(res)
    res = await globalFetch(currentUrl, {
      method,
      headers: sendCredentials ? { ...(config.headers ?? {}), ...authHeaders } : withoutCredentials(config.headers),
      ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
      signal,
      redirect: 'manual',
    })
    const newCookies = new CookieJar().collect(res)
    const cookieNote = newCookies.length ? ` [Set-Cookie: ${newCookies.join(', ')}]` : ''
    if (res.status < 300 || res.status >= 400) break
    const loc = res.headers.get('location')
    if (!loc) break
    const next = new URL(loc, currentUrl).toString()

    steps.push({ label: `→ ${res.status} ${next}${cookieNote}`, status: 'info', cookies: redactedCookies(newCookies) })
    if ((res.status === 303 && method !== 'GET' && method !== 'HEAD') || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET'
      body = undefined
    }
    if (new URL(next).origin !== new URL(currentUrl).origin) sendCredentials = false
    currentUrl = next
  }
  return res
}

// ── Databases (SQL Server, PostgreSQL, MySQL / MariaDB, MongoDB) ───────────────────

async function testDatabase(driver: DatabaseDriver, config: DatabaseConfig, timeoutMs: number): Promise<TestResult> {
  const steps: TestStep[] = []
  const totalStart = Date.now()
  const fail = (): TestResult => ({ overall: 'error', steps, totalMs: Date.now() - totalStart })
  let session: DatabaseSession | null = null

  try {
    let connection: DatabaseConnection
    let connectedLabel: string
    let failedLabel: string
    if (config.mode === 'connectionString') {
      if (!config.vault) {
        steps.push({ label: 'Connection string: no Vault secret configured', status: 'error' })
        return fail()
      }
      const t = Date.now()
      try {
        connection = { connectionString: await resolveConnectionString(driver, config.vault) }
        steps.push({ label: 'Connection string resolved from Vault', status: 'ok', durationMs: Date.now() - t })
      } catch (err) {
        steps.push({ label: 'Vault resolution failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
        return fail()
      }
      connectedLabel = 'Connected via connection string'
      failedLabel = 'Connection failed'
    } else {
      const t = Date.now()
      let user: string
      let password: string
      try {
        ;({ user, password } = await resolveFieldCredentials(config))
      } catch (err) {
        steps.push({ label: 'Vault resolution failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
        return fail()
      }
      steps.push(config.vault
        ? { label: 'Credentials resolved from Vault', status: 'ok', detail: `User: ${user}`, durationMs: Date.now() - t }
        : { label: 'Using direct credentials', status: 'info', detail: `User: ${user}` })
      connection = { host: config.host, port: config.port, database: config.database, user, password }
      connectedLabel = `Connected to ${config.host}:${config.port} / ${config.database}`
      failedLabel = `Connection to ${config.host}:${config.port} failed`
    }

    const tConnect = Date.now()
    try {
      session = await driver.connect(connection, timeoutMs)
      steps.push({ label: connectedLabel, status: 'ok', durationMs: Date.now() - tConnect })
    } catch (err) {
      steps.push({ label: failedLabel, status: 'error', detail: errMsg(err), durationMs: Date.now() - tConnect })
      return fail()
    }

    // ── Query ───────────────────────────────────────────────────────────────
    const query = config.query || driver.defaultQuery
    const t = Date.now()
    try {
      const rows = await session.query(query)
      const value = firstValue(rows) ?? '(no rows)'
      steps.push({
        label: `Query OK — ${rows.length} row(s) returned`,
        status: 'ok',
        detail: `${query} → ${value}`,
        durationMs: Date.now() - t,
      })

      if (config.expectedResult) {
        if (value === config.expectedResult) {
          steps.push({ label: `Expected result matched: "${config.expectedResult}"`, status: 'ok' })
        } else {
          steps.push({ label: 'Expected result mismatch', status: 'error', detail: `Expected "${config.expectedResult}", got "${value}"` })
          return fail()
        }
      }
    } catch (err) {
      steps.push({ label: 'Query failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
      return fail()
    }
  } catch (err) {
    steps.push({ label: 'Test failed', status: 'error', detail: errMsg(err) })
    return fail()
  } finally {
    await session?.close()
  }

  return { overall: 'ok', steps, totalMs: Date.now() - totalStart }
}

export const testSqlServer = (config: DatabaseConfig, timeoutMs: number) => testDatabase(sqlServerDriver, config, timeoutMs)
export const testPostgres = (config: DatabaseConfig, timeoutMs: number) => testDatabase(postgresDriver, config, timeoutMs)
export const testMysql = (config: DatabaseConfig, timeoutMs: number) => testDatabase(mysqlDriver, config, timeoutMs)
export const testMongo = (config: DatabaseConfig, timeoutMs: number) => testDatabase(mongoDriver, config, timeoutMs)

// ── Docker ────────────────────────────────────────────────────────────────────

export async function testDocker(config: DockerConfig, timeoutMs: number): Promise<TestResult> {
  const steps: TestStep[] = []
  const totalStart = Date.now()
  const fail = (): TestResult => ({ overall: 'error', steps, totalMs: Date.now() - totalStart })

  const invalid = validateDockerConfig(config)
  if (invalid) {
    steps.push({ label: 'Invalid configuration', status: 'error', detail: invalid })
    return fail()
  }
  steps.push({ label: `Docker endpoint: ${config.endpoint}`, status: 'info' })

  const t = Date.now()
  try {
    const state = await inspectContainer(config, timeoutMs)
    const { status, error } = evaluateContainer(state, config.container)
    if (state) {
      const health = state.health ? `, health: ${state.health}` : ''
      steps.push({ label: `Container "${config.container}" found`, status: 'ok', detail: `status: ${state.status}${health}`, durationMs: Date.now() - t })
    }
    if (status === 'up') {
      steps.push({ label: 'Container is running', status: 'ok' })
    } else {
      steps.push({ label: status === 'degraded' ? 'Container is degraded' : 'Container check failed', status: 'error', detail: error ?? undefined, durationMs: state ? undefined : Date.now() - t })
      return fail()
    }
  } catch (err) {
    steps.push({ label: 'Docker API request failed', status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
    return fail()
  }

  return { overall: 'ok', steps, totalMs: Date.now() - totalStart }
}

// ── Ping (TCP / ICMP) ─────────────────────────────────────────────────────────

export async function testPing(config: PingConfig, timeoutMs: number): Promise<TestResult> {
  const totalStart = Date.now()
  const target = config.mode === 'icmp'
    ? `ICMP ping to ${config.host}`
    : `TCP connect to ${config.host}:${config.port ?? 80}`
  const result = await checkPing(config, timeoutMs)
  const step: TestStep = result.status === 'up'
    ? { label: target, status: 'ok', durationMs: result.responseMs ?? 0 }
    : { label: `${target} failed`, status: 'error', detail: result.error ?? undefined, durationMs: Date.now() - totalStart }
  return { overall: result.status === 'up' ? 'ok' : 'error', steps: [step], totalMs: Date.now() - totalStart }
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
  let timer: ReturnType<typeof setTimeout> | undefined
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
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS query timed out')), timeoutMs) }),
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
  } finally {
    clearTimeout(timer)
  }
}

/** The headers fetch strips when a redirect crosses origins. */
const CROSS_ORIGIN_STRIPPED = new Set(['authorization', 'cookie', 'proxy-authorization'])

function withoutCredentials(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !CROSS_ORIGIN_STRIPPED.has(name.toLowerCase())))
}

