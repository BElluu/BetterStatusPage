import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, setSession } from '../api/client'
import ChangePasswordPage from './ChangePassword'

vi.mock('../api/client', () => ({
  api: { post: vi.fn() },
  setSession: vi.fn(),
}))

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/change-password']}>
      <Routes>
        <Route path="/admin/change-password" element={<ChangePasswordPage />} />
        <Route path="/admin/" element={<div>Admin home</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function fill(user: ReturnType<typeof userEvent.setup>, password: string, confirm = password) {
  await user.type(screen.getByPlaceholderText('Minimum 8 characters'), password)
  await user.type(screen.getByPlaceholderText('Repeat the password'), confirm)
}

describe('ChangePasswordPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects mismatched and too-short passwords without calling the API', async () => {
    const user = userEvent.setup()
    renderPage()

    await fill(user, 'correct-horse', 'correct-hors')
    await user.click(screen.getByRole('button', { name: 'Set Password & Continue' }))
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument()

    await user.clear(screen.getByPlaceholderText('Minimum 8 characters'))
    await user.clear(screen.getByPlaceholderText('Repeat the password'))
    await fill(user, 'short')
    // Bypass the browser's minLength check to exercise the page's own guard.
    fireEvent.submit(screen.getByRole('button', { name: 'Set Password & Continue' }).closest('form')!)
    expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('changes the password, stores the new session and continues to the admin', async () => {
    const user = userEvent.setup()
    const session = { userId: 1, email: 'a@example.test', role: 'admin', mustChangePassword: false, twoFactorEnabled: false }
    vi.mocked(api.post).mockResolvedValue(session)
    renderPage()

    await fill(user, 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Set Password & Continue' }))

    expect(await screen.findByText('Admin home')).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledWith('/auth/change-password', { newPassword: 'correct-horse' })
    expect(setSession).toHaveBeenCalledWith(session)
  })

  it('shows the server error and stays on the page', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValue(new Error('Password was used before'))
    renderPage()

    await fill(user, 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Set Password & Continue' }))

    expect(await screen.findByText('Password was used before')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set Password & Continue' })).toBeEnabled())
    expect(setSession).not.toHaveBeenCalled()
  })
})
