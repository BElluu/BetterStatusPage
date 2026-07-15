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

export function mustChangePassword(): boolean {
  return !!getCurrentUser()?.mustChangePassword
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
): Promise<T> {
  const headers: Record<string, string> = {}
  if (!isFormData && body !== undefined) headers['Content-Type'] = 'application/json'
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = cookie('bsp_csrf')
    if (csrf) headers['X-CSRF-Token'] = csrf
  }

  const fetchBody = isFormData ? (body as FormData) : body !== undefined ? JSON.stringify(body) : null
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    ...(fetchBody !== null ? { body: fetchBody } : {}),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
    if (res.status === 401) {
      clearSession()
      const isLoginRequest = path === '/auth/login' || path === '/auth/2fa/verify'
      if (!isLoginRequest && !window.location.pathname.includes('/login')) {
        window.location.href = '/admin/login'
      }
    }
    throw new Error(err.error ?? res.statusText)
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
