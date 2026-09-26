import { ADMIN, ADMIN_URL, STATUS_URL, expect, ok, pageAs, test } from './fixtures'

test('wrong credentials are rejected with a message', async ({ page }) => {
  await page.goto(`${ADMIN_URL}/login`)
  await page.locator('input[type="email"]').fill(ADMIN.email)
  await page.locator('input[type="password"]').fill('not-the-password')
  await page.locator('button[type="submit"]').click()
  await expect(page.getByText('Invalid credentials')).toBeVisible()
  await expect(page).toHaveURL(/\/admin\/login$/)
})

test('signed-out visitors are sent to the login page', async ({ page }) => {
  for (const path of ['/', '/monitors', '/users']) {
    await page.goto(`${ADMIN_URL}${path}`)
    await expect(page).toHaveURL(/\/admin\/login$/)
  }
})

test('an operator manages monitors but cannot reach administration pages', async ({ browser }) => {
  const page = await pageAs(browser, 'operator')
  await page.goto(`${ADMIN_URL}/monitors`)
  await expect(page.getByRole('heading', { name: 'Monitors' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Incidents/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Users/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /Vault/ })).toHaveCount(0)

  await page.goto(`${ADMIN_URL}/users`)
  await expect(page).toHaveURL(/\/admin\/?$/)
  await page.context().close()
})

test('a branding user edits the site name, which the status page picks up', async ({ browser, adminApi }) => {
  const page = await pageAs(browser, 'branding')
  await page.goto(`${ADMIN_URL}/monitors`)
  // Monitoring pages are off limits: the branding role lands on its own home.
  await expect(page).toHaveURL(/\/admin\/branding$/)
  await expect(page.getByRole('link', { name: /Monitors/ })).toHaveCount(0)

  const siteName = `Acme Status ${Date.now().toString(36)}`
  try {
    await page.getByPlaceholder('My Status Page').fill(siteName)
    await page.getByRole('button', { name: 'Save branding' }).click()
    await expect(page.getByText('Saved!')).toBeVisible()

    const visitor = await browser.newPage()
    await visitor.goto(STATUS_URL)
    await expect(visitor.getByText(siteName).first()).toBeVisible()
    await visitor.close()
  } finally {
    await ok(adminApi.patch('admin/branding', { data: { siteName: 'My Status Page' } }))
    await page.context().close()
  }
})

test('a new user must replace the temporary password, then can sign out', async ({ adminPage: admin, browser }) => {
  const email = `e2e-new-${Date.now()}@example.test`
  await admin.goto(`${ADMIN_URL}/users`)
  await admin.getByRole('button', { name: 'New User' }).click()
  await admin.getByPlaceholder('user@example.com').fill(email)
  await admin.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(admin.getByText('Share this temporary password. It will not be shown again.')).toBeVisible()
  const created = admin.locator('div').filter({ hasText: `User ${email} created` }).last()
  const temporaryPassword = (await created.locator('code').innerText()).trim()
  expect(temporaryPassword.length).toBeGreaterThanOrEqual(8)

  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${ADMIN_URL}/login`)
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').fill(temporaryPassword)
  await page.locator('button[type="submit"]').click()
  await expect(page).toHaveURL(/\/admin\/change-password$/)

  // Nothing else is reachable until the password is changed.
  await page.goto(`${ADMIN_URL}/branding`)
  await expect(page).toHaveURL(/\/admin\/change-password$/)

  await page.getByPlaceholder('Minimum 8 characters').fill('a-brand-new-password')
  await page.getByPlaceholder('Repeat the password').fill('a-brand-new-password')
  await page.getByRole('button', { name: 'Set Password & Continue' }).click()
  await expect(page).toHaveURL(/\/admin\/branding$/)

  await page.getByRole('button', { name: /Logout/ }).click()
  await expect(page).toHaveURL(/\/admin\/login$/)
  await page.goto(`${ADMIN_URL}/branding`)
  await expect(page).toHaveURL(/\/admin\/login$/)
  await context.close()
})
