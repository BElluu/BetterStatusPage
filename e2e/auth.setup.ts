import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { request, test as setup, expect } from '@playwright/test'
import { ADMIN, ADMIN_URL, API_URL, apiAs, credentialsFile, sessionFile, stateFile, type Role } from './fixtures'

setup('first-run wizard creates the administrator and signs them in', async ({ page }) => {
  mkdirSync(path.dirname(stateFile('admin')), { recursive: true })

  // A signed-out visitor to an unconfigured instance is sent to the wizard.
  await page.goto(`${ADMIN_URL}/login`)
  await expect(page).toHaveURL(/\/admin\/setup$/)
  await expect(page.getByRole('heading', { name: 'Choose a database' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Create admin account' })).toBeVisible()
  await page.getByPlaceholder('admin@example.com').fill(ADMIN.email)
  await page.getByPlaceholder('Min. 8 characters').fill(ADMIN.password)
  await page.getByPlaceholder('Repeat password').fill(`${ADMIN.password}-typo`)
  await page.getByRole('button', { name: 'Create Account' }).click()
  await expect(page.getByText('Passwords do not match')).toBeVisible()

  await page.getByPlaceholder('Repeat password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Create Account' }).click()
  await expect(page.getByRole('heading', { name: "You're all set." })).toBeVisible()
  await page.getByRole('button', { name: 'Go to Dashboard' }).click()
  await expect(page).toHaveURL(/\/admin\/?$/)

  await page.context().storageState({ path: stateFile('admin') })
  const user = await page.evaluate(() => window.sessionStorage.getItem('bsp-auth-user'))
  expect(user).toBeTruthy()
  writeFileSync(sessionFile('admin'), user!)
})

setup('provision operator and branding accounts', async () => {
  const admin = await apiAs('admin')
  for (const role of ['operator', 'branding'] as const satisfies readonly Role[]) {
    const email = `e2e-${role}@example.test`
    const password = `e2e-${role}-password`
    const created = await admin.post('admin/users', { data: { email } })
    expect(created.ok(), await created.text()).toBeTruthy()
    const { id, temporaryPassword } = await created.json() as { id: number; temporaryPassword: string }
    if (role !== 'branding') {
      const promoted = await admin.patch(`admin/users/${id}/role`, { data: { role } })
      expect(promoted.ok(), await promoted.text()).toBeTruthy()
    }

    // Sign in with the temporary password and replace it, as a new user would on first login.
    const client = await request.newContext({ baseURL: `${API_URL}/api/v1/` })
    const login = await client.post('auth/login', { data: { email, password: temporaryPassword } })
    expect(login.ok(), await login.text()).toBeTruthy()
    const csrf = (await client.storageState()).cookies.find((cookie) => cookie.name === 'bsp_csrf')?.value ?? ''
    const changed = await client.post('auth/change-password', { data: { newPassword: password }, headers: { 'X-CSRF-Token': csrf } })
    expect(changed.ok(), await changed.text()).toBeTruthy()
    const session = await changed.json()
    expect(session).toMatchObject({ email, role, mustChangePassword: false })

    await client.storageState({ path: stateFile(role) })
    writeFileSync(sessionFile(role), JSON.stringify(session))
    writeFileSync(credentialsFile(role), JSON.stringify({ email, password }))
    await client.dispose()
  }
  await admin.dispose()
})
