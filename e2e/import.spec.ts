import { ADMIN_URL, expect, ok, pageAs, test, type MonitorRow } from './fixtures'

const slug = () => `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

const monitorYaml = (key: string, name: string, interval = 3600) => `kind: Monitor
key: ${key}
name: ${name}
type: https
intervalSecs: ${interval}
config:
  url: http://127.0.0.1:9/
  method: GET
  expectedStatus: 200
`

test('a monitor is created by importing YAML and edited by importing it again', async ({ adminPage: page, adminApi }) => {
  const key = slug()
  const name = `Imported ${key}`
  await page.goto(`${ADMIN_URL}/import`)
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible()

  const box = page.getByLabel('Configuration to import')
  await box.fill(monitorYaml(key, name))
  // The text is checked after a pause; nothing is written until the changes are applied.
  await expect(page.getByText('1 to create')).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: key })).toContainText('Create')
  expect((await ok<MonitorRow[]>(adminApi.get('admin/monitors'))).some((monitor) => monitor.name === name)).toBe(false)

  await page.getByRole('button', { name: 'Apply changes' }).click()
  await expect(page.getByText('Applied.')).toBeVisible()
  const created = (await ok<Array<MonitorRow & { key: string }>>(adminApi.get('admin/monitors'))).find((monitor) => monitor.key === key)!
  expect(created.name).toBe(name)

  // The same key is an update, and the preview names the setting that differs.
  await box.fill(monitorYaml(key, name, 1800))
  await expect(page.getByText('1 to update')).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: key })).toContainText('intervalSecs')
  await page.getByRole('button', { name: 'Apply changes' }).click()
  await expect(page.getByText('Applied.')).toBeVisible()
  const updated = (await ok<Array<{ key: string; intervalSecs: number }>>(adminApi.get('admin/monitors'))).find((monitor) => monitor.key === key)!
  expect(updated.intervalSecs).toBe(1800)
})

test('a document with a mistake lists it with its place and cannot be applied', async ({ adminPage: page, adminApi }) => {
  const key = slug()
  await page.goto(`${ADMIN_URL}/import`)
  await page.getByLabel('Configuration to import').fill(`kind: Monitor\nkey: ${key}\nname: Broken\ntype: https\ndependsOn: [no-such-monitor]\nconfig:\n  url: http://127.0.0.1:9/\n`)

  await expect(page.getByText('This cannot be applied. Nothing was changed.')).toBeVisible()
  await expect(page.getByText(`Monitor[${key}].dependsOn`)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply changes' })).toHaveCount(0)
  expect((await ok<Array<{ key: string }>>(adminApi.get('admin/monitors'))).some((monitor) => monitor.key === key)).toBe(false)
})

test('a monitor shows itself as YAML, and the YAML is what the import reads', async ({ adminPage: page, adminApi }) => {
  const key = slug()
  const name = `Viewed ${key}`
  await page.goto(`${ADMIN_URL}/import`)
  await page.getByLabel('Configuration to import').fill(monitorYaml(key, name))
  await page.getByRole('button', { name: 'Apply changes' }).click()
  await expect(page.getByText('Applied.')).toBeVisible()
  const id = (await ok<Array<{ id: number; key: string }>>(adminApi.get('admin/monitors'))).find((monitor) => monitor.key === key)!.id

  await page.goto(`${ADMIN_URL}/monitors/${id}`)
  await page.getByRole('button', { name: 'YAML' }).click()
  const dialog = page.getByRole('dialog', { name: 'YAML' })
  await expect(dialog.getByLabel('YAML')).toContainText(`key: ${key}`)
  await expect(dialog.getByLabel('YAML')).toContainText('kind: Monitor')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)

  // Pasting the export back changes nothing.
  const yaml = await (await adminApi.get(`admin/config/export?kind=Monitor&key=${key}`)).text()
  await page.goto(`${ADMIN_URL}/import`)
  await page.getByLabel('Configuration to import').fill(yaml)
  await expect(page.getByText(/already matches this/)).toBeVisible()
})

test('an operator sees Import, a branding user does not and cannot open it', async ({ browser }) => {
  const operator = await pageAs(browser, 'operator')
  await operator.goto(`${ADMIN_URL}/monitors`)
  await expect(operator.getByRole('link', { name: /Import/ })).toBeVisible()
  await operator.context().close()

  const branding = await pageAs(browser, 'branding')
  await branding.goto(`${ADMIN_URL}/builder`)
  await expect(branding.getByRole('link', { name: /Import/ })).toHaveCount(0)
  await branding.goto(`${ADMIN_URL}/import`)
  await expect(branding).not.toHaveURL(/\/import$/)
  await branding.context().close()
})
