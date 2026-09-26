import { ADMIN, ADMIN_URL, expect, test } from './fixtures'

test('public status page loads seeded branding', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('My Status Page').first()).toBeVisible()
})

test('administrator can log in and reach the dashboard', async ({ page }) => {
  await page.goto(`${ADMIN_URL}/login`)
  await page.locator('input[type="email"]').fill(ADMIN.email)
  await page.locator('input[type="password"]').fill(ADMIN.password)
  await page.locator('button[type="submit"]').click()
  await expect(page).toHaveURL(/\/admin\/?$/)
})

test('public and admin layouts work on a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.locator('body')).toBeVisible()
  await page.goto(`${ADMIN_URL}/login`)
  await expect(page.locator('input[type="email"]')).toBeVisible()
})
