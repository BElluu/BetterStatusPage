import { ADMIN_URL, expect, test, unique } from './fixtures'

test('an administrator creates a vault, stores a secret, reveals it and deletes both', async ({ adminPage: page }) => {
  const vaultName = unique('E2E vault')
  const secretName = unique('e2e-secret')

  await page.goto(`${ADMIN_URL}/vault`)
  await page.getByRole('button', { name: 'Create vault' }).click()
  await page.getByPlaceholder('My Credentials').fill(vaultName)
  await page.getByRole('button', { name: 'Create Vault', exact: true }).click()
  await expect(page.getByRole('heading', { name: vaultName })).toBeVisible()

  await page.getByRole('button', { name: 'New Secret' }).click()
  await page.getByPlaceholder('my-api-key').fill(secretName)
  await page.getByRole('button', { name: /Secure Value/ }).click()
  await page.getByPlaceholder('Bearer eyJ…').fill('s3cr3t-token')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(secretName)).toBeVisible()

  // The list never carries the value; only an explicit reveal does.
  await expect(page.getByText('s3cr3t-token')).toHaveCount(0)
  await page.getByRole('button', { name: 'Reveal' }).click()
  await expect(page.getByRole('dialog').getByText('s3cr3t-token')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: `Delete secret ${secretName}` }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText(secretName)).toHaveCount(0)

  await page.getByRole('button', { name: `Delete vault ${vaultName}` }).click()
  await page.getByRole('dialog').getByRole('button', { name: /^Delete/ }).click()
  await expect(page.getByRole('heading', { name: vaultName })).toHaveCount(0)
})
