import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ADMIN_URL, expect, test, unique } from './fixtures'

const received: string[] = []
const receiver = createServer((req: IncomingMessage, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => { received.push(Buffer.concat(chunks).toString()); res.writeHead(200).end('ok') })
})

test.beforeAll(async () => { await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve)) })
test.afterAll(async () => { await new Promise<void>((resolve) => receiver.close(() => resolve())) })

test('an administrator adds a webhook channel, sends a test and deletes it', async ({ adminPage: page }) => {
  const name = unique('E2E webhook')
  const { port } = receiver.address() as AddressInfo

  await page.goto(`${ADMIN_URL}/notifications`)
  await page.getByRole('button', { name: 'Add Channel' }).click()
  await page.locator('button[aria-haspopup="listbox"]').click()
  await page.getByRole('option', { name: /Webhook/ }).click()
  await page.getByPlaceholder('My Email Alert').fill(name)
  await page.getByPlaceholder('https://example.com/alert').fill(`http://127.0.0.1:${port}/hook`)
  await page.getByRole('button', { name: 'Create Channel' }).click()
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()

  await page.getByRole('button', { name: `Edit ${name}` }).click()
  await page.getByRole('button', { name: 'Send test (saved settings)' }).click()
  await expect(page.getByText('Test sent successfully')).toBeVisible()
  await expect.poll(() => received.length).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Cancel' }).click()

  await page.getByRole('button', { name: `Delete ${name}` }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('cell', { name, exact: true })).toHaveCount(0)
})
