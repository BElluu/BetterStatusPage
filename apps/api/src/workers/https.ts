import type { HttpsConfig } from '@bsp/shared'
import type { MonitorStatus } from '@bsp/shared'
import { resolveVaultSecret } from './resolveSecret.js'

/**
 * Resolves the auth config into HTTP headers and (for CAS) a modified URL.
 * Returns { headers, url } — url equals serviceUrl unless CAS appended a ticket.
 */
async function resolveAuth(
  auth: HttpsConfig['auth'],
  serviceUrl: string,
): Promise<{ headers: Record<string, string>; url: string; cookieJar?: Map<string, string>; casState?: { casServerUrl: string; tgtUrl: string } }> {
  if (!auth || auth.type === 'none') return { headers: {}, url: serviceUrl }

  // ── Basic Auth ────────────────────────────────────────────────────────────
  if (auth.type === 'basic') {
    const cfg = auth.basic ?? { username: '', password: '' }
    let username = cfg.username ?? ''
    let password = cfg.password ?? ''
    if (cfg.vault) {
      const creds = await resolveVaultSecret(cfg.vault)
      username = creds['username'] ?? username
      password = creds['password'] ?? creds['value'] ?? password
    }
    const encoded = Buffer.from(`${username}:${password}`).toString('base64')
    return { headers: { Authorization: `Basic ${encoded}` }, url: serviceUrl }
  }

  // ── OAuth2 (client_credentials) ───────────────────────────────────────────
  if (auth.type === 'oauth2') {
    const cfg = auth.oauth2 ?? { tokenUrl: '', clientId: '', clientSecret: '' }
    let clientId     = cfg.clientId ?? ''
    let clientSecret = cfg.clientSecret ?? ''
    if (cfg.vault) {
      const creds = await resolveVaultSecret(cfg.vault)
      clientId     = creds['clientId']     ?? creds['username'] ?? clientId
      clientSecret = creds['clientSecret'] ?? creds['password'] ?? creds['value'] ?? clientSecret
    }
    const tokenUrl = cfg.tokenUrl ?? ''
    if (!tokenUrl) throw new Error('OAuth2: tokenUrl is required')

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
    if (!tokenRes.ok) {
      throw new Error(`OAuth2 token request failed with HTTP ${tokenRes.status}`)
    }
    const tokenData = await tokenRes.json() as { access_token?: string }
    if (!tokenData.access_token) throw new Error('OAuth2: no access_token in response')
    return { headers: { Authorization: `Bearer ${tokenData.access_token}` }, url: serviceUrl }
  }

  // ── CAS (REST protocol v3) ────────────────────────────────────────────────
  if (auth.type === 'cas') {
    const cfg = auth.cas ?? { casServerUrl: '', username: '', password: '' }
    let username     = cfg.username ?? ''
    let password     = cfg.password ?? ''
    const casServerUrl = cfg.casServerUrl ?? ''
    if (cfg.vault) {
      const creds = await resolveVaultSecret(cfg.vault)
      username = creds['username'] ?? username
      password = creds['password'] ?? creds['value'] ?? password
    }
    if (!casServerUrl) throw new Error('CAS: casServerUrl is required')

    // Step 1: probe the service URL, following redirects manually to collect session
    // cookies and discover the exact session-specific service URL CAS expects.
    // The ticket must be validated in the same session the app created during the probe.
    let effectiveServiceUrl = serviceUrl
    const probeCookies = new Map<string, string>()
    try {
      let nextUrl = serviceUrl
      for (let hops = 0; hops < 10; hops++) {
        const cookieHeader = [...probeCookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
        const r = await fetch(nextUrl, {
          redirect: 'manual',
          ...(cookieHeader ? { headers: { Cookie: cookieHeader } } : {}),
          signal: AbortSignal.timeout(5000),
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const setCookies: string[] = (r.headers as any).getSetCookie?.() ?? []
        for (const c of setCookies) {
          const kv = c.split(';')[0]?.trim() ?? ''
          const eq = kv.indexOf('=')
          if (eq > 0) probeCookies.set(kv.substring(0, eq), kv.substring(eq + 1))
        }
        if (r.status < 300 || r.status >= 400) break
        const location = r.headers.get('location')
        if (!location) break
        const resolved = new URL(location, nextUrl)
        const service = resolved.searchParams.get('service')
        if (service) { effectiveServiceUrl = service; break }
        nextUrl = resolved.toString()
      }
    } catch { /* keep original service URL */ }

    // Step 2: obtain TGT
    const tgtRes = await fetch(`${casServerUrl}/v1/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }).toString(),
    })
    if (!tgtRes.ok) throw new Error(`CAS: TGT request failed with HTTP ${tgtRes.status}`)
    const tgtUrl = tgtRes.headers.get('location')
    if (!tgtUrl) throw new Error('CAS: no Location header in TGT response')

    // Step 3: obtain service ticket for the exact service URL discovered above
    const stRes = await fetch(tgtUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ service: effectiveServiceUrl }).toString(),
    })
    if (!stRes.ok) throw new Error(`CAS: service ticket request failed with HTTP ${stRes.status}`)
    const ticket = (await stRes.text()).trim()

    // Step 4: append ?ticket=ST-xxx to the effective service URL.
    // Return the cookie jar so checkHttps can carry cookies across the redirect chain —
    // after ticket validation the app sets an authenticated session cookie that must be
    // forwarded on subsequent hops.
    const u = new URL(effectiveServiceUrl)
    u.searchParams.set('ticket', ticket)
    return { headers: {}, url: u.toString(), cookieJar: probeCookies, casState: { casServerUrl, tgtUrl } }
  }

  return { headers: {}, url: serviceUrl }
}

export async function checkHttps(
  config: HttpsConfig,
  timeoutMs: number,
): Promise<{ status: MonitorStatus; responseMs: number | null; error: string | null }> {
  const start = Date.now()
  try {
    const { headers: authHeaders, url, cookieJar, casState } = await resolveAuth(config.auth, config.url)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res: Response
    if (cookieJar) {
      const jar = new Map<string, string>(cookieJar)

      function jarCookieHdr() {
        const h = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
        return h ? { Cookie: h } : {}
      }
      function collectJarCookies(r: Response) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sc: string[] = (r.headers as any).getSetCookie?.() ?? []
        for (const c of sc) {
          const kv = c.split(';')[0]?.trim() ?? ''
          const eq = kv.indexOf('=')
          if (eq > 0) jar.set(kv.substring(0, eq), kv.substring(eq + 1))
        }
      }

      // Phase 1: RegisterServiceTicket — single GET to {serviceUrl}?ticket={st}.
      // nginx validates the ticket and sets NGXCAS in the response (even on a 302).
      // Do NOT follow the redirect; we only need the cookies from this response.
      res = await fetch(url, {
        method: 'GET',
        headers: { ...jarCookieHdr() },
        signal: controller.signal,
        redirect: 'manual',
      })
      collectJarCookies(res)

      // Phase 2: visit the monitored URL with NGXCAS + session cookies.
      // If the app has its own CAS layer it will redirect to CAS login — intercept
      // and get a fresh ticket; NGINX will pass it to the app (NGXCAS is already valid).
      let currentUrl2 = config.url
      for (let hops = 0; hops < 10; hops++) {
        res = await fetch(currentUrl2, {
          method: config.method ?? 'GET',
          headers: { ...(config.headers ?? {}), ...authHeaders, ...jarCookieHdr() },
          body: config.body ?? undefined,
          signal: controller.signal,
          redirect: 'manual',
        })
        collectJarCookies(res)
        if (res.status < 300 || res.status >= 400) break
        const loc = res.headers.get('location')
        if (!loc) break
        const next = new URL(loc, currentUrl2).toString()
        if (casState && next.startsWith(`${casState.casServerUrl}/login`)) {
          const svc = new URL(next).searchParams.get('service')
          if (svc) {
            const stRes2 = await fetch(casState.tgtUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ service: svc }).toString(),
            })
            if (!stRes2.ok) throw new Error(`CAS app-level ticket failed HTTP ${stRes2.status}`)
            const ticket2 = (await stRes2.text()).trim()
            const u2 = new URL(svc)
            u2.searchParams.set('ticket', ticket2)
            currentUrl2 = u2.toString()
            continue
          }
        }
        currentUrl2 = next
      }
    } else {
      res = await fetch(url, {
        method: config.method ?? 'GET',
        headers: { ...(config.headers ?? {}), ...authHeaders },
        body: config.body ?? undefined,
        signal: controller.signal,
        redirect: 'follow',
      })
    }
    clearTimeout(timer)

    const responseMs = Date.now() - start
    const expectedStatus = config.expectedStatus ?? 200

    if (res.status !== expectedStatus) {
      return {
        status: 'down',
        responseMs,
        error: `Expected HTTP ${expectedStatus}, got ${res.status}`,
      }
    }

    if (config.keyword) {
      const body = await res.text()
      if (!body.includes(config.keyword)) {
        return {
          status: 'degraded',
          responseMs,
          error: `Keyword "${config.keyword}" not found in response body`,
        }
      }
    }

    return { status: 'up', responseMs, error: null }
  } catch (err) {
    const responseMs = Date.now() - start
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 'down', responseMs, error: msg }
  }
}
