import { ADMIN_URL, apiAs, expect, test } from './fixtures'

test('an administrator creates a backup, validates its archive and deletes it', async ({ adminPage: page, adminApi }) => {
  await page.goto(`${ADMIN_URL}/backups`)
  await page.getByRole('button', { name: 'Create backup' }).click()
  await expect(page.getByText('Backup created successfully.')).toBeVisible()

  const row = page.getByRole('button', { name: /^Download / }).first()
  const filename = (await row.getAttribute('aria-label'))!.replace(/^Download /, '')

  // The downloaded archive is accepted by the validator the restore command relies on.
  const download = await adminApi.get(`admin/backups/${encodeURIComponent(filename)}/download`)
  expect(download.ok()).toBeTruthy()
  await page.getByLabel('Restore file').setInputFiles({ name: filename, mimeType: 'application/octet-stream', buffer: await download.body() })
  await expect(page.getByText(/Backup is valid/)).toBeVisible()

  await page.getByRole('button', { name: `Delete ${filename}` }).click()
  const dialog = page.getByRole('dialog')
  const confirm = dialog.getByRole('button', { name: 'Delete backup' })
  await expect(confirm).toBeDisabled()
  await dialog.getByRole('textbox').fill(filename)
  await confirm.click()
  await expect(page.getByText('Backup deleted.')).toBeVisible()
  await expect(page.getByRole('button', { name: `Download ${filename}` })).toHaveCount(0)
})

test('a non-administrator cannot list backups', async () => {
  const operator = await apiAs('operator')
  expect((await operator.get('admin/backups')).status()).toBe(403)
  await operator.dispose()
})
