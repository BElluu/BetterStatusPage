import { ADMIN_URL, expect, test } from './fixtures'

const MONITORS_CHUNK = /\/pages\/Monitors\.tsx/

test('a page whose chunk is gone offers a reload instead of a blank screen', async ({ adminPage: page }) => {
  await page.route(MONITORS_CHUNK, (route) => route.abort())
  await page.goto(`${ADMIN_URL}/monitors`)
  await expect(page.getByRole('alert')).toContainText('A new version is available')

  // After the upgrade the files are served again: Reload brings the page back.
  await page.unroute(MONITORS_CHUNK)
  await page.getByRole('button', { name: 'Reload' }).click()
  await expect(page.getByRole('button', { name: 'Add Monitor' })).toBeVisible()
})

test('a page that is still loading shows a spinner', async ({ adminPage: page }) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route(MONITORS_CHUNK, async (route) => {
    await gate
    await route.continue()
  })
  await page.goto(`${ADMIN_URL}/monitors`, { waitUntil: 'commit' })
  await expect(page.getByRole('status')).toContainText('Loading')
  release()
  await expect(page.getByRole('button', { name: 'Add Monitor' })).toBeVisible()
})
