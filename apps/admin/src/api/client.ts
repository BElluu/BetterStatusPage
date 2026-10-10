import { navigation, statusPageUrl } from '../navigation'

const BASE = '/api/v1'
const USER_KEY = 'bsp-auth-user'

// Remove credentials left by versions that stored JWTs in sessionStorage.
sessionStorage.removeItem('token')
sessionStorage.removeItem('mustChangePwd')

export interface AuthUser {
  userId: number
  email: string
  role: string
  mustChangePassword: boolean
  twoFactorEnabled: boolean
  authMethod?: 'password' | 'oidc'
}

export function setSession(user: AuthUser): void {
  sessionStorage.setItem(USER_KEY, JSON.stringify(user))
  window.dispatchEvent(new CustomEvent('bsp-auth-change'))
}

export function clearSession(): void {
  sessionStorage.removeItem(USER_KEY)
  window.dispatchEvent(new CustomEvent('bsp-auth-change'))
}

export function getCurrentUser(): AuthUser | null {
  try {
    const stored = sessionStorage.getItem(USER_KEY)
    return stored ? JSON.parse(stored) as AuthUser : null
  } catch { return null }
}

export function isAuthenticated(): boolean {
  return getCurrentUser() !== null
}

/** A viewer may only view the status page; the admin console is closed to them. */
export function isViewer(user: AuthUser | null): boolean {
  return user?.role === 'viewer'
}

/**
 * Where a signed-in user starts. A viewer goes to the status page, which also has them replace a temporary
 * password; everyone else replaces it here first.
 */
export function enterAfterSignIn(user: AuthUser, navigate: (path: string) => void): void {
  if (isViewer(user)) navigation.assign(statusPageUrl())
  else if (user.mustChangePassword) navigate('/admin/change-password')
  else navigate('/admin/')
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
): Promise<T> {
  const headers: Record<string, string> = {}
  if (contentType) headers['Content-Type'] = contentType
  else if (!isFormData && body !== undefined) headers['Content-Type'] = 'application/json'
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = cookie('bsp_csrf')
    if (csrf) headers['X-CSRF-Token'] = csrf
  }

  const fetchBody = contentType ? (body as string) : isFormData ? (body as FormData) : body !== undefined ? JSON.stringify(body) : null
  const res = await fetch(`${BASE}${path}`, {
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
        window.location.href = '/admin/change-password'
      }
    }
    if (res.status === 401) {
      clearSession()
      const isLoginRequest = path === '/auth/login' || path === '/auth/2fa/verify'
      if (!isLoginRequest && !window.location.pathname.includes('/login')) {
        window.location.href = '/admin/login'
      }
    }
    throw new ApiError(err.error ?? res.statusText, res.status, err.code, err)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: (path: string) => request<void>('DELETE', path),
  upload: <T>(path: string, formData: FormData) => request<T>('POST', path, formData, true),
  /** POST a text body as it is, for example a YAML file, with the given content type. */
  postText: <T>(path: string, text: string, contentType: string) => request<T>('POST', path, text, false, contentType),
  download: async (path: string, filename: string) => {
    const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin' })
    if (!res.ok) throw new Error('Download failed')
    const url = URL.createObjectURL(await res.blob())
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  },
}
