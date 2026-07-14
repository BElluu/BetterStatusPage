import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, clearSession, getCurrentUser, setSession, type AuthUser } from './client'

const user: AuthUser = {
  userId: 1,
  email: 'admin@example.test',
  role: 'admin',
  mustChangePassword: false,
  twoFactorEnabled: true,
}

afterEach(() => {
  clearSession()
  vi.unstubAllGlobals()
})

describe('admin API session client', () => {
  it('stores only non-sensitive user state and never a JWT', () => {
    setSession(user)
    expect(getCurrentUser()).toEqual(user)
    expect(sessionStorage.getItem('token')).toBeNull()
  })

  it('sends cookies and the CSRF header for mutations', async () => {
    document.cookie = 'bsp_csrf=test-csrf; path=/'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(user), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await api.post('/auth/session-test', { enabled: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/session-test', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      headers: expect.objectContaining({ 'X-CSRF-Token': 'test-csrf' }),
    }))
  })
})
