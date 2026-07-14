import { expect, test } from '@playwright/test'

const email = 'e2e-admin@example.test'
const password = 'e2e-secure-password'
const apiUrl = `http://127.0.0.1:${process.env['E2E_API_PORT'] ?? '3000'}`

test.beforeAll(async ({ request }) => {
  const status = await request.get(`${apiUrl}/api/v1/setup/status`)
  if ((await status.json()).needsSetup) {
    const setup = await request.post(`${apiUrl}/api/v1/setup/complete`, {
      data: { email, password },
    })
    expect(setup.ok()).toBeTruthy()
  }
})

test('public status page loads seeded branding', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('My Status Page').first()).toBeVisible()
})

test('administrator can log in and reach the dashboard', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/admin/login')
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').fill(password)
  await page.locator('button[type="submit"]').click()
  await expect(page).toHaveURL(/\/admin\/?$/)
})

test('public and admin layouts work on a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.locator('body')).toBeVisible()
  await page.goto('http://127.0.0.1:5173/admin/login')
  await expect(page.locator('input[type="email"]')).toBeVisible()
})
