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
): Promise<{ headers: Record<string, string>; url: string }> {
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

    // Step 1: obtain TGT
    const tgtRes = await fetch(`${casServerUrl}/v1/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }).toString(),
    })
    if (!tgtRes.ok) throw new Error(`CAS: TGT request failed with HTTP ${tgtRes.status}`)
    const tgtUrl = tgtRes.headers.get('location')
    if (!tgtUrl) throw new Error('CAS: no Location header in TGT response')

    // Step 2: obtain service ticket
    const stRes = await fetch(tgtUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ service: serviceUrl }).toString(),
    })
    if (!stRes.ok) throw new Error(`CAS: service ticket request failed with HTTP ${stRes.status}`)
    const ticket = (await stRes.text()).trim()

    // Step 3: append ?ticket=ST-xxx to the service URL
    const u = new URL(serviceUrl)
    u.searchParams.set('ticket', ticket)
    return { headers: {}, url: u.toString() }
  }

  return { headers: {}, url: serviceUrl }
}

export async function checkHttps(
  config: HttpsConfig,
  timeoutMs: number,
): Promise<{ status: MonitorStatus; responseMs: number | null; error: string | null }> {
  const start = Date.now()
  try {
    const { headers: authHeaders, url } = await resolveAuth(config.auth, config.url)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const res = await fetch(url, {
      method: config.method ?? 'GET',
      headers: { ...(config.headers ?? {}), ...authHeaders },
      signal: controller.signal,
      redirect: 'follow',
    })
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
