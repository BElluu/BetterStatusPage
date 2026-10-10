import { readFile } from 'node:fs/promises'
import { ADMIN_URL, expect, ok, test, unique, type MonitorRow } from './fixtures'

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const yamlFile = (text: string) => ({ name: 'bsp.yaml', mimeType: 'text/yaml', buffer: Buffer.from(text) })

test('an administrator previews a YAML file, applies it, and applying it again changes nothing', async ({ adminPage: page, adminApi }) => {
  const name = unique('Imported heartbeat')
  const key = slug(name)
  const file = yamlFile(`version: 1
monitors:
  - key: ${key}
    name: ${name}
    type: webhook
    config: {}
    tags:
      - { label: iac, color: "#3366ff" }
`)
  await page.goto(`${ADMIN_URL}/configuration`)
  await page.getByLabel('Configuration file').setInputFiles(file)

  // The file is checked as soon as it is chosen, and nothing exists yet.
  await expect(page.getByText('1 to create')).toBeVisible()
  const row = page.getByRole('row').filter({ hasText: key })
  await expect(row).toContainText('Create')
  await expect(row).toContainText('Monitor')
  expect((await ok<MonitorRow[]>(adminApi.get('admin/monitors'))).some((monitor) => monitor.name === name)).toBe(false)

  await page.getByRole('button', { name: 'Apply changes' }).click()
  await expect(page.getByText('The configuration was applied.')).toBeVisible()

  const created = (await ok<Array<MonitorRow & { key: string; tags: unknown }>>(adminApi.get('admin/monitors'))).find((monitor) => monitor.name === name)!
  expect(created.key).toBe(key)
  expect(created.tags).toEqual([{ label: 'iac', color: '#3366ff' }])

  // It is a monitor like any other.
  await page.goto(`${ADMIN_URL}/monitors`)
  await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible()

  // The same file again: nothing to do.
  await page.goto(`${ADMIN_URL}/configuration`)
  await page.getByLabel('Configuration file').setInputFiles(file)
  await expect(page.getByText(/already matches this file/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply changes' })).toHaveCount(0)
})

test('a file with mistakes is refused with their place, and changes nothing', async ({ adminPage: page, adminApi }) => {
  const name = unique('Never created')
  const monitor = `  - key: ${slug(name)}
    name: ${name}
    type: webhook
    config: {}`
  await page.goto(`${ADMIN_URL}/configuration`)

  // First the shape of the file: a setting the format does not have, and a key that is not one.
  await page.getByLabel('Configuration file').setInputFiles(yamlFile(`version: 1
monitors:
${monitor}
    intervalSec: 30
  - key: Not A Key
    name: Second
    type: webhook
`))
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Nothing was changed')
  await expect(alert.getByText(`monitors[${slug(name)}].intervalSec`)).toBeVisible()
  await expect(alert).toContainText('is not a known setting')
  await expect(alert.getByText('monitors[1].key')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply changes' })).toHaveCount(0)

  // Then what it refers to, once its shape is right.
  await page.getByLabel('Configuration file').setInputFiles(yamlFile(`version: 1
monitors:
${monitor}
    dependsOn: [ghost-monitor]
`))
  await expect(alert.getByText(`monitors[${slug(name)}].dependsOn`)).toBeVisible()
  await expect(alert).toContainText('unknown monitor "ghost-monitor"')
  await expect(page.getByRole('button', { name: 'Apply changes' })).toHaveCount(0)
  expect((await ok<MonitorRow[]>(adminApi.get('admin/monitors'))).some((monitor) => monitor.name === name)).toBe(false)
})

test('the export is a file without secrets', async ({ adminPage: page, adminApi }) => {
  const name = unique('Monitor with a password')
  await ok(adminApi.post('admin/monitors', {
    data: {
      name, type: 'https', intervalSecs: 3600,
      config: { url: 'http://127.0.0.1:9/', method: 'GET', expectedStatus: 200, auth: { type: 'basic', basic: { username: 'svc', password: 'e2e-very-secret-password' } } },
    },
  }))

  await page.goto(`${ADMIN_URL}/configuration`)
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download/ }).click()])
  expect(download.suggestedFilename()).toBe('bsp-config.yaml')
  const text = await readFile((await download.path())!, 'utf8')

  expect(text).toMatch(/^version: 1$/m)
  expect(text).toContain(name)
  expect(text).toContain('••••••••')
  expect(text).not.toContain('e2e-very-secret-password')
})

test('pruning asks first, and removes only what the file leaves out', async ({ adminPage: page, adminApi }) => {
  // A file with every monitor there is, so that the one created next is the only one it leaves out.
  const everything = await ok<{ version: number; monitors: unknown[] }>(adminApi.get('admin/config/export?format=json'))
  const name = unique('Leave me out')
  await ok(adminApi.post('admin/monitors', { data: { name, type: 'webhook', config: {} } }))
  const before = await ok<MonitorRow[]>(adminApi.get('admin/monitors'))

  await page.goto(`${ADMIN_URL}/configuration`)
  await page.getByLabel('Configuration file').setInputFiles({
    name: 'bsp.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, monitors: everything.monitors })),
  })
  await expect(page.getByText(/unchanged/)).toBeVisible()
  await expect(page.getByText(/already matches this file/)).toBeVisible()

  await page.getByRole('switch', { name: /Remove what the file leaves out/ }).click()
  await expect(page.getByText(/1 to remove/)).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: slug(name) })).toContainText('Remove')

  await page.getByRole('button', { name: 'Apply changes' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('removes 1 monitor that is not in it')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect(await ok<MonitorRow[]>(adminApi.get('admin/monitors'))).toHaveLength(before.length)

  await page.getByRole('button', { name: 'Apply changes' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Apply and remove' }).click()
  await expect(page.getByText('The configuration was applied.')).toBeVisible()

  const after = await ok<MonitorRow[]>(adminApi.get('admin/monitors'))
  expect(after).toHaveLength(before.length - 1)
  expect(after.some((monitor) => monitor.name === name)).toBe(false)
})
