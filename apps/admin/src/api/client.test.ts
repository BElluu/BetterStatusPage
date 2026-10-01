import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, clearSession, enterAfterSignIn, getCurrentUser, setSession, type AuthUser } from './client'
import { navigation } from '../navigation'

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

  it('marks the session as needing a password change when the API requires one', async () => {
    setSession(user)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(api.get('/admin/monitors')).rejects.toThrow('Password change required')
    expect(getCurrentUser()?.mustChangePassword).toBe(true)
  })
})

describe('enterAfterSignIn', () => {
  it('sends a viewer to the status page and everyone else into the console', () => {
    const navigate = vi.fn()
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => {})

    enterAfterSignIn({ ...user, role: 'viewer' }, navigate)
    expect(assign).toHaveBeenCalledWith('/')
    expect(navigate).not.toHaveBeenCalled()

    // The status page has them replace a temporary password; the console stays closed to them.
    enterAfterSignIn({ ...user, role: 'viewer', mustChangePassword: true }, navigate)
    expect(assign).toHaveBeenCalledTimes(2)
    expect(navigate).not.toHaveBeenCalled()

    enterAfterSignIn({ ...user, mustChangePassword: true }, navigate)
    expect(navigate).toHaveBeenLastCalledWith('/admin/change-password')
    enterAfterSignIn(user, navigate)
    expect(navigate).toHaveBeenLastCalledWith('/admin/')
    assign.mockRestore()
  })
})
