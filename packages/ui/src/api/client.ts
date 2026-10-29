import { safeSessionStorage } from '@better-forge/contracts'
import { storageKey, uiConfig } from '../config'
import { navigation } from '../navigation'

const userKey = () => storageKey('auth-user')

export interface AuthUser {
  userId: number
  email: string
  role: string
  mustChangePassword: boolean
  twoFactorEnabled: boolean
  authMethod?: 'password' | 'oidc'
}

export function setSession(user: AuthUser): void {
  safeSessionStorage.set(userKey(), JSON.stringify(user))
  window.dispatchEvent(new CustomEvent(storageKey('auth-change')))
}

export function clearSession(): void {
  safeSessionStorage.remove(userKey())
  window.dispatchEvent(new CustomEvent(storageKey('auth-change')))
}

export function getCurrentUser(): AuthUser | null {
  try {
    const stored = safeSessionStorage.get(userKey())
    return stored ? JSON.parse(stored) as AuthUser : null
  } catch { return null }
}

export function isAuthenticated(): boolean {
  return getCurrentUser() !== null
}

/**
 * Where a signed-in user starts. One who does not belong in this interface goes where the application sends them
 * (which may also have them replace a temporary password); everyone else replaces it here first.
 */
export function enterAfterSignIn(user: AuthUser, navigate: (path: string) => void): void {
  const elsewhere = uiConfig().redirectAfterSignIn?.(user) ?? null
  if (elsewhere) navigation.assign(elsewhere)
  else if (user.mustChangePassword) navigate(`${uiConfig().basePath}/change-password`)
  else navigate(`${uiConfig().basePath}/`)
}

export function mustChangePassword(): boolean {
  return !!getCurrentUser()?.mustChangePassword
}

/**
 * A failed API call: `message` is the server's error text, `code` its machine-readable code when it sent one, and
 * `body` the whole JSON answer, for the endpoints that say more than a message (a list of problems, say).
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly body?: unknown) {
    super(message)
    this.name = 'ApiError'
  }
}

function cookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`
  const part = document.cookie.split('; ').find((item) => item.startsWith(prefix))
  return part ? decodeURIComponent(part.slice(prefix.length)) : null
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  isFormData = false,
  /** Sends `body` (a string) as it is with this content type, instead of as JSON. */
  contentType?: string,
  /** Reads the answer as text instead of JSON. */
  asText = false,
): Promise<T> {
  const headers: Record<string, string> = {}
  if (contentType) headers['Content-Type'] = contentType
  else if (!isFormData && body !== undefined) headers['Content-Type'] = 'application/json'
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = cookie(uiConfig().csrfCookie)
    if (csrf) headers['X-CSRF-Token'] = csrf
  }

  const fetchBody = contentType ? (body as string) : isFormData ? (body as FormData) : body !== undefined ? JSON.stringify(body) : null
  const res = await fetch(`${uiConfig().apiBase}${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    ...(fetchBody !== null ? { body: fetchBody } : {}),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; code?: string }
    if (res.status === 403 && err.code === 'PASSWORD_CHANGE_REQUIRED') {
      const user = getCurrentUser()
      if (user && !user.mustChangePassword) setSession({ ...user, mustChangePassword: true })
      if (!window.location.pathname.includes('/change-password')) {
        window.location.href = `${uiConfig().basePath}/change-password`
      }
    }
    if (res.status === 401) {
      clearSession()
      const isLoginRequest = path === '/auth/login' || path === '/auth/2fa/verify'
      if (!isLoginRequest && !window.location.pathname.includes('/login')) {
        window.location.href = `${uiConfig().basePath}/login`
      }
    }
    throw new ApiError(err.error ?? res.statusText, res.status, err.code, err)
  }

  if (res.status === 204) return undefined as T
  return (asText ? res.text() : res.json()) as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  /** GET an answer that is text, for example a YAML document. */
  getText: (path: string) => request<string>('GET', path, undefined, false, undefined, true),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: (path: string) => request<void>('DELETE', path),
  upload: <T>(path: string, formData: FormData) => request<T>('POST', path, formData, true),
  /** POST a text body as it is, for example a YAML file, with the given content type. */
  postText: <T>(path: string, text: string, contentType: string) => request<T>('POST', path, text, false, contentType),
  download: async (path: string, filename: string) => {
    const res = await fetch(`${uiConfig().apiBase}${path}`, { credentials: 'same-origin' })
    if (!res.ok) throw new Error('Download failed')
    const url = URL.createObjectURL(await res.blob())
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  },
}
