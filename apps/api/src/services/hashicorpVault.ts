import { Agent, fetch as httpFetch } from 'undici'
import { encrypt, decrypt } from '../crypto/vault.js'

/**
 * Client for HashiCorp Vault (KV v2). A BetterStatusPage vault of type `hashicorp` keeps only the
 * connection settings (encrypted); secret values are read live on every use and never stored.
 *
 * The Vault address is private-network by nature, so unlike webhooks no public-IP guard applies.
 * Instead the token is protected by: no redirects, strict path-segment validation, a response size
 * cap and fixed error messages that never echo request headers, bodies or credentials.
 */

export type HashicorpAuthMethod = 'token' | 'approle'

export interface HashicorpConfig {
  address: string
  namespace?: string
  mount: string
  authMethod: HashicorpAuthMethod
  token?: string | undefined
  roleId?: string
  secretId?: string
  approleMount: string
  caCert?: string
}

/** Message is always safe to return to the browser. */
export class HashicorpVaultError extends Error {}

/** Mutable so tests can shorten the timeout. */
export const hashicorpLimits = {
  timeoutMs: 10_000,
  maxBodyBytes: 1024 * 1024,
  /** A 403 for a token younger than this is a policy denial, not an expired token: no new login. */
  freshTokenMs: 10_000,
  /** Grace period before a replaced connection pool is closed, so in-flight requests can finish. */
  agentCloseDelayMs: 30_000,
}

const MAX_FIELD = 2048
const MAX_CA = 64 * 1024

function text(value: unknown, label: string, max = MAX_FIELD): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new HashicorpVaultError(`${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new HashicorpVaultError(`${label} is too long`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new HashicorpVaultError(`${label} contains invalid characters`)
  return trimmed || undefined
}

/** Validates a slash-separated Vault path and returns it URL-encoded per segment. */
export function encodePath(raw: string, label: string): string {
  const segments = raw.trim().replace(/^\/+|\/+$/g, '').split('/')
  if (segments.length === 0 || segments.some((s) => s === '')) {
    throw new HashicorpVaultError(`${label} is invalid`)
  }
  return segments.map((segment) => {
    let decoded: string
    try { decoded = decodeURIComponent(segment) } catch { throw new HashicorpVaultError(`${label} is invalid`) }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new HashicorpVaultError(`${label} is invalid`)
    }
    return encodeURIComponent(decoded)
  }).join('/')
}

function requiredText(value: unknown, label: string): string {
  const v = text(value, label)
  if (!v) throw new HashicorpVaultError(`${label} is required`)
  return v
}

function normalizeAddress(raw: string): string {
  let url: URL
  try { url = new URL(raw) } catch { throw new HashicorpVaultError('Address must be a valid URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HashicorpVaultError('Address must start with http:// or https://')
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new HashicorpVaultError('Address must be a plain URL such as https://vault.example.com:8200')
  }
  return url.origin
}

/** True when changing these fields would redirect stored credentials somewhere else. */
const IDENTITY_FIELDS = ['address', 'namespace', 'mount', 'authMethod', 'approleMount', 'caCert'] as const

/**
 * Validates connection input from the admin API. With `existing`, blank credentials keep the stored
 * ones, except when the address, namespace, auth method or AppRole mount changes: credentials must
 * then be sent again, so a changed address cannot receive a stored token.
 */
export function parseConnection(input: unknown, existing?: HashicorpConfig): HashicorpConfig {
  if (!input || typeof input !== 'object') throw new HashicorpVaultError('Connection settings are required')
  const body = input as Record<string, unknown>

  const authMethod = body['authMethod'] ?? existing?.authMethod
  if (authMethod !== 'token' && authMethod !== 'approle') {
    throw new HashicorpVaultError('Auth method must be token or approle')
  }
  const namespace = text(body['namespace'], 'Namespace')
  const cfg: HashicorpConfig = {
    address: normalizeAddress(requiredText(body['address'], 'Address')),
    mount: requiredText(body['mount'] ?? 'secret', 'KV mount'),
    authMethod,
    approleMount: text(body['approleMount'], 'AppRole mount') ?? 'approle',
  }
  if (namespace) cfg.namespace = namespace
  encodePath(cfg.mount, 'KV mount')
  encodePath(cfg.approleMount, 'AppRole mount')
  if (cfg.namespace) encodePath(cfg.namespace, 'Namespace')

  const caCert = text(body['caCert'], 'CA certificate', MAX_CA)
  if (caCert) {
    if (!caCert.includes('BEGIN CERTIFICATE')) throw new HashicorpVaultError('CA certificate must be PEM encoded')
    cfg.caCert = caCert
  }

  const identityChanged = existing ? IDENTITY_FIELDS.some((f) => (existing[f] ?? '') !== (cfg[f] ?? '')) : false
  const keep = existing && !identityChanged ? existing : undefined
  if (authMethod === 'token') {
    const token = text(body['token'], 'Token') ?? keep?.token
    if (!token) throw new HashicorpVaultError(identityChanged ? 'Re-enter the token after changing the connection target' : 'Token is required')
    cfg.token = token
  } else {
    const roleId = text(body['roleId'], 'Role ID') ?? keep?.roleId
    const secretId = text(body['secretId'], 'Secret ID') ?? keep?.secretId
    if (!roleId || !secretId) {
      throw new HashicorpVaultError(identityChanged ? 'Re-enter the Role ID and Secret ID after changing the connection target' : 'Role ID and Secret ID are required')
    }
    cfg.roleId = roleId
    cfg.secretId = secretId
  }
  return cfg
}

export function sealConnection(cfg: HashicorpConfig): string {
  return encrypt(JSON.stringify(cfg))
}

export function openConnection(sealed: string | null): HashicorpConfig {
  if (!sealed) throw new HashicorpVaultError('Vault connection is not configured')
  try {
    return JSON.parse(decrypt(sealed)) as HashicorpConfig
  } catch {
    throw new HashicorpVaultError('Failed to decrypt vault connection')
  }
}

/** Connection settings safe to return to admins: credentials are reported only as present or not. */
export function publicConnection(cfg: HashicorpConfig) {
  return {
    address: cfg.address,
    namespace: cfg.namespace ?? '',
    mount: cfg.mount,
    authMethod: cfg.authMethod,
    approleMount: cfg.approleMount,
    roleId: cfg.roleId ?? '',
    caCert: cfg.caCert ?? '',
    hasToken: !!cfg.token,
    hasSecretId: !!cfg.secretId,
  }
}

// ── Requests ──────────────────────────────────────────────────────────────────

export interface HashicorpVaultRow {
  id: number
  updatedAt: number
  connectionConfig: string | null
}

interface Session {
  fingerprint: number
  cfg: HashicorpConfig
  agent?: Agent | undefined
  token?: string | undefined
  expiresAt: number
  loginAt: number
  login?: Promise<string> | undefined
}

const sessions = new Map<number, Session>()

/** Drops the cached token and closes the connection pool; call after the vault is changed or deleted. */
export function forgetHashicorpVault(vaultId: number): void {
  const session = sessions.get(vaultId)
  sessions.delete(vaultId)
  const agent = session?.agent
  if (agent) setTimeout(() => void agent.close().catch(() => undefined), hashicorpLimits.agentCloseDelayMs).unref()
}

function sessionFor(vault: HashicorpVaultRow): Session {
  const existing = sessions.get(vault.id)
  if (existing && existing.fingerprint === vault.updatedAt) return existing
  forgetHashicorpVault(vault.id)
  const cfg = openConnection(vault.connectionConfig)
  const session: Session = {
    fingerprint: vault.updatedAt,
    cfg,
    agent: cfg.caCert ? new Agent({ connect: { ca: cfg.caCert } }) : undefined,
    expiresAt: 0,
    loginAt: 0,
  }
  sessions.set(vault.id, session)
  return session
}

function scrub(message: string, cfg: HashicorpConfig): string {
  let out = message
  for (const secret of [cfg.token, cfg.secretId]) if (secret) out = out.split(secret).join('[redacted]')
  return out
}

function describeNetworkError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return `timed out after ${Math.round(hashicorpLimits.timeoutMs / 1000)} s`
  }
  const code = e?.cause?.code ?? ''
  if (/redirect/i.test(e?.cause?.message ?? e?.message ?? '')) return 'redirects are not followed'
  if (/^(UNABLE_TO|CERT_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH)/.test(code)) {
    return `TLS certificate not trusted (${code})`
  }
  return code ? `cannot connect (${code})` : 'cannot connect'
}

async function readCapped(res: Awaited<ReturnType<typeof httpFetch>>): Promise<unknown> {
  const reader = res.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > hashicorpLimits.maxBodyBytes) {
      void reader.cancel()
      throw new HashicorpVaultError('response from Vault is too large')
    }
    chunks.push(value)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null }
}

async function call(
  session: Session,
  method: 'GET' | 'POST',
  apiPath: string,
  token: string | undefined,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const { cfg } = session
  const headers: Record<string, string> = { 'X-Vault-Request': 'true' }
  if (token) headers['X-Vault-Token'] = token
  if (cfg.namespace) headers['X-Vault-Namespace'] = cfg.namespace
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const res = await httpFetch(`${cfg.address}/v1/${apiPath}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(hashicorpLimits.timeoutMs),
      ...(session.agent && { dispatcher: session.agent }),
    })
    return { status: res.status, json: await readCapped(res) }
  } catch (err) {
    if (err instanceof HashicorpVaultError) throw err
    throw new HashicorpVaultError(scrub(describeNetworkError(err), cfg))
  }
}

function login(session: Session): Promise<string> {
  session.login ??= (async () => {
    const { cfg } = session
    const { status, json } = await call(session, 'POST', `auth/${encodePath(cfg.approleMount, 'AppRole mount')}/login`, undefined,
      { role_id: cfg.roleId, secret_id: cfg.secretId })
    const auth = (json as { auth?: { client_token?: string; lease_duration?: number } } | null)?.auth
    if (status !== 200 || !auth?.client_token) {
      throw new HashicorpVaultError(status === 400 || status === 403 ? 'AppRole login was rejected' : `AppRole login failed (HTTP ${status})`)
    }
    const ttlMs = (auth.lease_duration ?? 0) * 1000
    session.token = auth.client_token
    session.loginAt = Date.now()
    // A lease of 0 means the token does not expire; a 403 then decides when to log in again.
    session.expiresAt = ttlMs > 0 ? session.loginAt + ttlMs - Math.min(60_000, ttlMs * 0.1) : Infinity
    return auth.client_token
  })().finally(() => { session.login = undefined })
  return session.login
}

async function tokenFor(session: Session): Promise<string> {
  if (session.cfg.authMethod === 'token') return session.cfg.token!
  if (session.token && Date.now() < session.expiresAt) return session.token
  return login(session)
}

/** Authenticated request; with AppRole a 403 triggers one fresh login and retry. */
async function authed(session: Session, method: 'GET' | 'POST', apiPath: string) {
  const used = await tokenFor(session)
  let res = await call(session, method, apiPath, used)
  const expired = session.cfg.authMethod === 'approle' && session.token === used
    && Date.now() - session.loginAt >= hashicorpLimits.freshTokenMs
  if (res.status === 403 && expired) {
    session.token = undefined
    res = await call(session, method, apiPath, await tokenFor(session))
  }
  return res
}

/** Reads the data of a KV v2 secret (latest version). */
export async function readKvSecret(vault: HashicorpVaultRow, path: string): Promise<Record<string, unknown>> {
  const session = sessionFor(vault)
  const kvPath = encodePath(path, 'Path')
  const { status, json } = await authed(session, 'GET', `${encodePath(session.cfg.mount, 'KV mount')}/data/${kvPath}`)
  if (status === 404) throw new HashicorpVaultError(`secret not found at ${session.cfg.mount}/${path.replace(/^\/+|\/+$/g, '')}`)
  if (status === 403) throw new HashicorpVaultError('permission denied (HTTP 403)')
  const data = (json as { data?: { data?: unknown } } | null)?.data?.data
  if (status !== 200 || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HashicorpVaultError(`unexpected response from Vault (HTTP ${status})`)
  }
  return data as Record<string, unknown>
}

/** Verifies the saved credentials. Returns the remaining token TTL when Vault reports one. */
export async function testConnection(vault: HashicorpVaultRow): Promise<{ authMethod: HashicorpAuthMethod; ttlSeconds: number | null }> {
  const session = sessionFor(vault)
  session.token = undefined
  session.loginAt = 0
  const { cfg } = session
  if (cfg.authMethod === 'approle') {
    await login(session)
    return { authMethod: 'approle', ttlSeconds: Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)) }
  }
  const { status, json } = await call(session, 'GET', 'auth/token/lookup-self', cfg.token)
  if (status === 403) throw new HashicorpVaultError('token was rejected (HTTP 403)')
  if (status !== 200) throw new HashicorpVaultError(`unexpected response from Vault (HTTP ${status})`)
  const ttl = (json as { data?: { ttl?: number } } | null)?.data?.ttl
  return { authMethod: 'token', ttlSeconds: typeof ttl === 'number' && ttl > 0 ? ttl : null }
}
