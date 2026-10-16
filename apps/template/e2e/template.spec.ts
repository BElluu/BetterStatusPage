import { expect, test } from '@playwright/test'

// The template uses nothing but the shared modules; this is what a person sees of them.
test('sets the application up, signs in and reaches every shared page', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/setup$/)

  await page.getByRole('button', { name: 'Continue' }).click()
  await page.locator('#setup-email').fill('admin@example.test')
  await page.locator('#setup-password').fill('a-long-password')
  await page.locator('#setup-confirm-password').fill('a-long-password')
  await page.getByRole('button', { name: 'Create Account' }).click()
  await page.getByRole('button', { name: 'Go to Dashboard' }).click()

  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()

  for (const [link, heading] of [
    ['Users', /Users/], ['Vault', /Vault/], ['API tokens', /API tokens/], ['Audit Log', /Audit log/i], ['Backups', /Backups/],
  ] as const) {
    await nav.getByRole('link', { name: link }).click()
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible()
  }

  await page.getByRole('link', { name: 'Settings' }).first().click()
  await expect(page.getByRole('heading', { name: /Settings/ }).first()).toBeVisible()
})

test('a signed-out visitor is sent to the sign-in page, which signs the administrator back in', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/users')
  await expect(page).toHaveURL(/\/login$/)
  await page.getByLabel('Email', { exact: true }).fill('admin@example.test')
  await page.getByLabel('Password', { exact: true }).fill('a-long-password')
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
})
