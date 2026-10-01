import { ADMIN_URL, STATUS_URL, expect, ok, test } from './fixtures'

test('a private status page asks visitors to sign in and shows itself to a viewer', async ({ browser, adminApi }) => {
  const email = `e2e-viewer-${Date.now()}@example.test`
  const created = await ok<{ temporaryPassword: string }>(adminApi.post('admin/users', { data: { email, role: 'viewer' } }))
  await ok(adminApi.put('admin/status-page-access', { data: { private: true } }))
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(STATUS_URL)
    await expect(page.getByRole('heading', { name: 'Sign in to see the status' })).toBeVisible()
    expect((await page.request.get(`${STATUS_URL}/api/v1/public/status`)).status()).toBe(401)

    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill(created.temporaryPassword)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    // The temporary password is replaced on the status page itself.
    await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible()
    await page.getByLabel('New password').fill('viewer-password')
    await page.getByLabel('Repeat the password').fill('viewer-password')
    await page.getByRole('button', { name: 'Set password and continue' }).click()
    await expect(page.locator('#status')).toBeVisible()

    // The admin console is closed to a viewer: it sends them back to the status page.
    await page.goto(`${ADMIN_URL}/monitors`)
    await expect(page).toHaveURL(`${STATUS_URL}/`)
    await expect(page.locator('#status')).toBeVisible()

    await page.getByRole('button', { name: 'Account' }).click()
    await expect(page.getByText(`Signed in as ${email}`)).toBeVisible()
    await expect(page.getByRole('link', { name: 'Admin console' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in to see the status' })).toBeVisible()
  } finally {
    await ok(adminApi.put('admin/status-page-access', { data: { private: false } }))
    await context.close()
  }
})
