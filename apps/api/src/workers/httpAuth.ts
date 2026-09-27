import type { HttpsConfig } from '@bsp/shared'
import { resolveVaultSecret } from './resolveSecret.js'

// Shared by the scheduled HTTPS check and the "Test" button so both authenticate the same way.
// The scheduled check passes no step reporter; the test runner turns every step into diagnostics.

/** One diagnostic step of the HTTP flow — the same shape the test runner reports. */
export interface HttpStep {
  label: string
  status: 'ok' | 'error' | 'info'
  detail?: string | undefined
  cookies?: Record<string, string> | undefined
  durationMs?: number | undefined
}

export interface HttpRequest {
  method?: string
  headers?: Record<string, string>
  body?: string
  redirect: 'manual' | 'follow'
  signal: AbortSignal
}

/** The part of a fetch Response the checks rely on; satisfied by both global and undici fetch. */
export interface HttpResponse {
  status: number
  ok: boolean
  headers: { get(name: string): string | null; getSetCookie?(): string[] }
  body?: { cancel(): Promise<void> } | null
  text(): Promise<string>
  json(): Promise<unknown>
}

export type HttpFetch = (url: string, init: HttpRequest) => Promise<HttpResponse>

export interface HttpFlowOptions {
  fetch: HttpFetch
  /** Aborts every request of the flow; the caller's timeout covers authentication too. */
  signal: AbortSignal
  onStep?: ((step: HttpStep) => void) | undefined
}

export interface ResolvedHttpAuth {
  headers: Record<string, string>
  /** The URL to request first: the service URL, or for CAS the service URL carrying a ticket. */
  url: string
  cas: { serverUrl: string; tgtUrl: string; jar: CookieJar } | null
}

/** How long one hop of the CAS discovery probe may take; the probe is best-effort. */
const CAS_PROBE_HOP_TIMEOUT_MS = 5_000
const MAX_REDIRECT_HOPS = 10

export class CookieJar {
  private readonly cookies: Map<string, string>

  constructor(initial?: CookieJar) {
    this.cookies = new Map(initial?.cookies)
  }

  /** Stores every Set-Cookie of a response and returns the names it set. */
  collect(res: HttpResponse): string[] {
    const names: string[] = []
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = c.split(';')[0]?.trim() ?? ''
      const eq = kv.indexOf('=')
      if (eq > 0) {
        this.cookies.set(kv.substring(0, eq), kv.substring(eq + 1))
        names.push(kv.substring(0, eq))
      }
    }
    return names
  }

  header(): Record<string, string> {
    const h = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    return h ? { Cookie: h } : {}
  }

  names(): string[] {
    return [...this.cookies.keys()]
  }

  get size(): number {
    return this.cookies.size
  }
}

/** Cookie names only — values are session secrets and never reach diagnostics. */
export function redactedCookies(names: string[]): Record<string, string> | undefined {
  return names.length > 0 ? Object.fromEntries(names.map((name) => [name, '[redacted]'])) : undefined
}

/** Releases a response body that will not be read, so its connection is not held open. */
export async function discardBody(res: HttpResponse): Promise<void> {
  try { await res.body?.cancel() } catch { /* already consumed or errored */ }
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Runs one stage of the flow: reports `ok` (or nothing) on success, and on failure reports the
 * `error` label with the error message as detail before rethrowing.
 */
async function stage<T>(
  opts: HttpFlowOptions,
  error: string,
  work: () => Promise<{ value: T; ok?: Omit<HttpStep, 'durationMs'> }>,
): Promise<T> {
  const t = Date.now()
  try {
    const { value, ok } = await work()
    if (ok) opts.onStep?.({ ...ok, durationMs: Date.now() - t })
    return value
  } catch (err) {
    opts.onStep?.({ label: error, status: 'error', detail: errMsg(err), durationMs: Date.now() - t })
    throw err
  }
}

/** Reports a precondition failure and throws. */
function fail(opts: HttpFlowOptions, label: string, message: string): never {
  opts.onStep?.({ label, status: 'error' })
  throw new Error(message)
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' }

/** Asks CAS for a service ticket for `service` using an existing ticket-granting ticket. */
export async function requestServiceTicket(fetch: HttpFetch, tgtUrl: string, service: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(tgtUrl, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({ service }).toString(),
    redirect: 'manual',
    signal,
  })
  if (!res.ok) {
    await discardBody(res)
    throw new Error(`CAS: service ticket request failed with HTTP ${res.status}`)
  }
  return (await res.text()).trim()
}

/**
 * Resolves the auth config into request headers and, for CAS, a ticketed URL plus the session
 * cookies collected while discovering it. Throws when authentication cannot be completed.
 */
export async function resolveHttpAuth(
  auth: HttpsConfig['auth'],
  serviceUrl: string,
  opts: HttpFlowOptions,
): Promise<ResolvedHttpAuth> {
  if (!auth || auth.type === 'none') {
    opts.onStep?.({ label: 'Authorization: none', status: 'info' })
    return { headers: {}, url: serviceUrl, cas: null }
  }

  // ── Basic Auth ────────────────────────────────────────────────────────────
  if (auth.type === 'basic') {
    const cfg = auth.basic ?? { username: '', password: '' }
    return stage(opts, 'Basic Auth: failed to resolve credentials', async () => {
      let username = cfg.username ?? ''
      let password = cfg.password ?? ''
      if (cfg.vault) {
        const creds = await resolveVaultSecret(cfg.vault)
        username = creds['username'] ?? username
        password = creds['password'] ?? creds['value'] ?? password
      }
      const encoded = Buffer.from(`${username}:${password}`).toString('base64')
      return {
        value: { headers: { Authorization: `Basic ${encoded}` }, url: serviceUrl, cas: null },
        ok: {
          label: cfg.vault ? 'Basic Auth: credentials resolved from Vault' : 'Basic Auth: using direct credentials',
          status: 'ok',
          detail: `User: ${username}`,
        },
      }
    })
  }

  // ── OAuth2 (client_credentials) ───────────────────────────────────────────
  if (auth.type === 'oauth2') {
    const cfg = auth.oauth2 ?? { tokenUrl: '', clientId: '', clientSecret: '' }
    let clientId     = cfg.clientId ?? ''
    let clientSecret = cfg.clientSecret ?? ''
    if (cfg.vault) {
      const vault = cfg.vault
      await stage(opts, 'OAuth2: Vault resolution failed', async () => {
        const creds = await resolveVaultSecret(vault)
        clientId     = creds['clientId']     ?? creds['username'] ?? clientId
        clientSecret = creds['clientSecret'] ?? creds['password'] ?? creds['value'] ?? clientSecret
        return { value: undefined, ok: { label: 'OAuth2: credentials resolved from Vault', status: 'ok', detail: `Client ID: ${clientId}` } }
      })
    }
    const tokenUrl = cfg.tokenUrl ?? ''
    if (!tokenUrl) fail(opts, 'OAuth2: Token URL is missing', 'OAuth2: tokenUrl is required')

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    })
    if (cfg.scope) params.set('scope', cfg.scope)

    return stage(opts, `OAuth2: token request to ${tokenUrl} failed`, async () => {
      const tokenRes = await opts.fetch(tokenUrl, {
        method: 'POST',
        headers: FORM,
        body: params.toString(),
        redirect: 'follow',
        signal: opts.signal,
      })
      if (!tokenRes.ok) {
        await discardBody(tokenRes)
        throw new Error(`OAuth2 token request failed with HTTP ${tokenRes.status}`)
      }
      const tokenData = await tokenRes.json() as { access_token?: string; expires_in?: number; token_type?: string }
      if (!tokenData.access_token) throw new Error('OAuth2: token response is missing access_token')
      const meta = [
        tokenData.token_type ?? 'Bearer',
        tokenData.expires_in != null ? `expires in ${tokenData.expires_in}s` : null,
      ].filter(Boolean).join(', ')
      return {
        value: { headers: { Authorization: `Bearer ${tokenData.access_token}` }, url: serviceUrl, cas: null },
        ok: { label: `OAuth2: token obtained from ${tokenUrl}`, status: 'ok', detail: meta },
      }
    })
  }

  // ── CAS (REST protocol v3) ────────────────────────────────────────────────
  if (auth.type === 'cas') {
    const cfg = auth.cas ?? { casServerUrl: '', username: '', password: '' }
    const casServerUrl = cfg.casServerUrl ?? ''
    let username = cfg.username ?? ''
    let password = cfg.password ?? ''
    if (cfg.vault) {
      const vault = cfg.vault
      await stage(opts, 'CAS: Vault resolution failed', async () => {
        const creds = await resolveVaultSecret(vault)
        username = creds['username'] ?? username
        password = creds['password'] ?? creds['value'] ?? password
        return { value: undefined, ok: { label: 'CAS: credentials resolved from Vault', status: 'ok' } }
      })
    }
    if (!casServerUrl) fail(opts, 'CAS: Server URL is missing', 'CAS: casServerUrl is required')

    // Step 1: obtain the ticket-granting ticket — bad credentials fail here, before any probing.
    const tgtUrl = await stage(opts, 'CAS: TGT request failed', async () => {
      const tgtRes = await opts.fetch(`${casServerUrl}/v1/tickets`, {
        method: 'POST',
        headers: FORM,
        body: new URLSearchParams({ username, password }).toString(),
        redirect: 'manual',
        signal: opts.signal,
      })
      await discardBody(tgtRes)
      if (!tgtRes.ok) throw new Error(`CAS: TGT request failed with HTTP ${tgtRes.status}`)
      const location = tgtRes.headers.get('location')
      if (!location) throw new Error('CAS: no Location header in TGT response')
      return { value: location, ok: { label: `CAS: TGT obtained from ${casServerUrl}`, status: 'ok' } }
    })

    // Step 2: probe the service URL, following redirects manually to collect session cookies and
    // discover the exact session-specific service URL CAS expects. The ticket must be validated in
    // the same session the app created during the probe.
    const jar = new CookieJar()
    const effectiveServiceUrl = await probeCasService(serviceUrl, jar, opts)

    // Step 3: obtain a service ticket for the exact service URL discovered above.
    const ticket = await stage(opts, 'CAS: service ticket request failed', async () => {
      const st = await requestServiceTicket(opts.fetch, tgtUrl, effectiveServiceUrl, opts.signal)
      return { value: st, ok: { label: 'CAS: service ticket obtained', status: 'ok', detail: `${st.substring(0, 24)}…` } }
    })

    // Step 4: append ?ticket=ST-xxx to the effective service URL. The cookie jar travels with it —
    // after ticket validation the app sets an authenticated session cookie that must be forwarded
    // on subsequent hops.
    const u = new URL(effectiveServiceUrl)
    u.searchParams.set('ticket', ticket)
    opts.onStep?.({ label: 'CAS: submitting ticket to', status: 'info', detail: u.toString() })
    return { headers: {}, url: u.toString(), cas: { serverUrl: casServerUrl, tgtUrl, jar } }
  }

  return { headers: {}, url: serviceUrl, cas: null }
}

/** Best-effort discovery of the service URL CAS will validate; falls back to the configured URL. */
async function probeCasService(serviceUrl: string, jar: CookieJar, opts: HttpFlowOptions): Promise<string> {
  const tProbe = Date.now()
  let effectiveServiceUrl = serviceUrl
  try {
    let nextUrl = serviceUrl
    for (let hops = 0; hops < MAX_REDIRECT_HOPS; hops++) {
      const r = await opts.fetch(nextUrl, {
        redirect: 'manual',
        headers: jar.header(),
        signal: AbortSignal.any([opts.signal, AbortSignal.timeout(CAS_PROBE_HOP_TIMEOUT_MS)]),
      })
      await discardBody(r)
      const newCookieNames = jar.collect(r)
      const cookies = redactedCookies(newCookieNames)
      const detail = newCookieNames.length > 0 ? `Set-Cookie: ${newCookieNames.join(', ')}` : undefined
      if (r.status < 300 || r.status >= 400) {
        opts.onStep?.({ label: `CAS probe hop ${hops + 1}: ${r.status} ${nextUrl}`, status: 'info', detail, cookies })
        break
      }
      const location = r.headers.get('location')
      opts.onStep?.({ label: `CAS probe hop ${hops + 1}: ${r.status} ${nextUrl} → ${location ?? '(no location)'}`, status: 'info', detail, cookies })
      if (!location) break
      const resolved = new URL(location, nextUrl)
      const service = resolved.searchParams.get('service')
      if (service) {
        effectiveServiceUrl = service
        opts.onStep?.({ label: 'CAS: effective service URL discovered', status: 'info', detail: effectiveServiceUrl, durationMs: Date.now() - tProbe })
        break
      }
      nextUrl = resolved.toString()
    }
    if (effectiveServiceUrl === serviceUrl) {
      opts.onStep?.({ label: 'CAS: probe — no service param found, using original URL', status: 'info', durationMs: Date.now() - tProbe })
    }
    opts.onStep?.({
      label: `CAS probe: ${jar.size} session cookie(s) collected`,
      status: 'info',
      detail: jar.size > 0 ? jar.names().join(', ') : 'none',
    })
  } catch (err) {
    // The flow's own timeout still ends the whole check; only a slow probe hop is tolerated.
    if (opts.signal.aborted) throw err
    opts.onStep?.({ label: 'CAS: probe failed, using original URL', status: 'info', detail: errMsg(err), durationMs: Date.now() - tProbe })
  }
  return effectiveServiceUrl
}

/**
 * Requests a CAS-protected URL with a resolved ticket. Phase 1 registers the ticket (a single GET
 * whose response sets the proxy session cookie, even on a redirect). Phase 2 visits the monitored
 * URL with those cookies; if the application has its own CAS layer and redirects to the CAS login,
 * a fresh ticket is requested for it — the proxy session is valid now, so the ticket reaches the app.
 * Returns the final response, body unread.
 */
export async function requestWithCas(
  config: HttpsConfig,
  auth: ResolvedHttpAuth & { cas: NonNullable<ResolvedHttpAuth['cas']> },
  opts: HttpFlowOptions,
): Promise<HttpResponse> {
  const jar = new CookieJar(auth.cas.jar)

  const tTicket = Date.now()
  let res = await opts.fetch(auth.url, { method: 'GET', headers: jar.header(), redirect: 'manual', signal: opts.signal })
  await discardBody(res)
  jar.collect(res)
  opts.onStep?.({
    label: `CAS: ticket registered → ${res.status}`,
    status: 'ok',
    detail: `Cookies collected: ${jar.names().join(', ')}`,
    cookies: redactedCookies(jar.names()),
    durationMs: Date.now() - tTicket,
  })

  let method = (config.method ?? 'GET').toUpperCase()
  let body: string | undefined = config.body
  let currentUrl = config.url
  for (let hops = 0; hops < MAX_REDIRECT_HOPS; hops++) {
    // The previous hop was a redirect; only the final response keeps its body for the caller.
    if (hops > 0) await discardBody(res)
    res = await opts.fetch(currentUrl, {
      method,
      headers: { ...(config.headers ?? {}), ...auth.headers, ...jar.header() },
      ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
      redirect: 'manual',
      signal: opts.signal,
    })
    const newCookies = jar.collect(res)
    const cookies = redactedCookies(newCookies)
    const cookieNote = newCookies.length ? ` [Set-Cookie: ${newCookies.join(', ')}]` : ''
    if (res.status < 300 || res.status >= 400) break
    const loc = res.headers.get('location')
    if (!loc) break
    const next = new URL(loc, currentUrl).toString()

    if (next.startsWith(`${auth.cas.serverUrl}/login`)) {
      const svc = new URL(next).searchParams.get('service')
      if (svc) {
        const ticket = await stage(opts, 'CAS: app-level ticket request failed', async () => ({
          value: await requestServiceTicket(opts.fetch, auth.cas.tgtUrl, svc, opts.signal),
          ok: { label: `CAS: app-level ticket obtained${cookieNote}`, status: 'info', detail: '[redacted]', cookies },
        }))
        const u = new URL(svc)
        u.searchParams.set('ticket', ticket)
        currentUrl = u.toString()
        continue
      }
    }

    opts.onStep?.({ label: `→ ${res.status} ${next}${cookieNote}`, status: 'info', cookies })
    // Redirects follow fetch semantics: 303 (and 301/302 after POST) turn into a body-less GET.
    if ((res.status === 303 && method !== 'GET' && method !== 'HEAD') || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET'
      body = undefined
    }
    currentUrl = next
  }
  return res
}
