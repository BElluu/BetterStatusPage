const BASE = '/api/v1'

function getToken(): string | null {
  return sessionStorage.getItem('token')
}

export function setToken(token: string, mustChangePassword = false) {
  sessionStorage.setItem('token', token)
  sessionStorage.setItem('mustChangePwd', mustChangePassword ? '1' : '0')
}

export function clearToken() {
  sessionStorage.removeItem('token')
  sessionStorage.removeItem('mustChangePwd')
}

export function isAuthenticated(): boolean {
  return !!getToken()
}

export function mustChangePassword(): boolean {
  return sessionStorage.getItem('mustChangePwd') === '1'
}

export function getCurrentUser(): { userId: number; email: string; role: string } | null {
  const token = getToken()
  if (!token) return null
  try {
    const p = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
    // handle legacy multi-role tokens (roles array) from previous implementation
    const role: string = p.role ?? (Array.isArray(p.roles) ? (p.roles[0] ?? 'branding') : 'branding')
    return { userId: p.userId, email: p.email, role }
  } catch { return null }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  isFormData = false,
): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (!isFormData && body !== undefined) headers['Content-Type'] = 'application/json'

  const fetchBody = isFormData ? (body as FormData) : body !== undefined ? JSON.stringify(body) : null

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(fetchBody !== null ? { body: fetchBody } : {}),
  })

  if (res.status === 401) {
    clearToken()
    if (!window.location.pathname.includes('/login')) {
      window.location.href = '/admin/login'
    }
    throw new Error('Incorrect email or password')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error: string }
    throw new Error(err.error ?? res.statusText)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: (path: string) => request<void>('DELETE', path),
  upload: <T>(path: string, formData: FormData) => request<T>('POST', path, formData, true),
}
