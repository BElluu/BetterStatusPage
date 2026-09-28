import { ADMIN_URL, API_URL, STATUS_URL, checkNow, createHttpMonitor, expect, ok, setPublicLayout, test, unique, waitUntilPublished, type MonitorRow } from './fixtures'

const HEALTHY_URL = `${API_URL}/health`
// Port 9 (discard) is closed on CI runners and developer machines alike.
const CLOSED_URL = 'http://127.0.0.1:9/'

test('operator creates an HTTP monitor, tests it and sees it go up', async ({ adminPage: page, adminApi }) => {
  const name = unique('Health endpoint')
  await page.goto(`${ADMIN_URL}/monitors`)
  await page.getByRole('button', { name: 'Add Monitor' }).click()

  await page.getByPlaceholder('My Service').fill(name)
  await page.getByPlaceholder('https://example.com').fill(HEALTHY_URL)
  await page.getByPlaceholder('must contain…').fill('ok')

  // The Test button runs the real probe against the configured endpoint before anything is saved.
  await page.getByRole('button', { name: /Test$/ }).click()
  await expect(page.getByText('All checks passed')).toBeVisible()

  await page.getByRole('button', { name: 'Create Monitor' }).click()
  const row = page.getByRole('row').filter({ hasText: name })
  await expect(row).toBeVisible()

  await row.getByTitle('Check now').click()
  await expect(row.getByText('Operational')).toBeVisible()

  const monitors = await ok<MonitorRow[]>(adminApi.get('admin/monitors'))
  const created = monitors.find((monitor) => monitor.name === name)!
  expect(created.currentStatus).toBe('up')
})

test('the Test button reports a failing endpoint without saving it', async ({ adminPage: page, adminApi }) => {
  const name = unique('Broken endpoint')
  await page.goto(`${ADMIN_URL}/monitors`)
  await page.getByRole('button', { name: 'Add Monitor' }).click()
  await page.getByPlaceholder('My Service').fill(name)
  await page.getByPlaceholder('https://example.com').fill(CLOSED_URL)

  await page.getByRole('button', { name: /Test$/ }).click()
  await expect(page.getByText('Test failed')).toBeVisible()
  await expect(page.getByText('Request failed')).toBeVisible()

  await page.getByRole('button', { name: 'Cancel' }).click()
  const monitors = await ok<MonitorRow[]>(adminApi.get('admin/monitors'))
  expect(monitors.some((monitor) => monitor.name === name)).toBe(false)
})

test('the public page shows an outage and recovers live when the monitor comes back', async ({ page, adminApi }) => {
  const name = unique('Checkout API')
  const monitor = await createHttpMonitor(adminApi, name, CLOSED_URL)
  await checkNow(adminApi, monitor.id)
  await setPublicLayout(adminApi, [monitor.id])
  await waitUntilPublished({ [monitor.id]: 'down' })

  await page.goto(STATUS_URL)
  await expect(page.getByText(name)).toBeVisible()
  await expect(page.getByText('Major Outage.')).toBeVisible()

  // Fix the endpoint while the page stays open: the change must arrive over SSE, without a reload.
  await ok(adminApi.patch(`admin/monitors/${monitor.id}`, { data: { config: { url: HEALTHY_URL, method: 'GET', expectedStatus: 200 } } }))
  await checkNow(adminApi, monitor.id)
  await expect(page.getByText('All systems operational.')).toBeVisible()
})

test('a webhook monitor goes up when its generated URL is called', async ({ adminPage: page, request }) => {
  const name = unique('Nightly job')
  await page.goto(`${ADMIN_URL}/monitors`)
  await page.getByRole('button', { name: 'Add Monitor' }).click()
  await page.getByPlaceholder('My Service').fill(name)
  await page.getByRole('button', { name: 'Webhook' }).click()
  await page.getByRole('button', { name: 'Create Monitor' }).click()

  const hookUrl = await page.locator('input[readonly][value*="/api/v1/hook/"]').inputValue()
  expect(hookUrl).toMatch(/\/api\/v1\/hook\/[0-9a-f]+$/)
  await page.getByRole('button', { name: 'Done' }).click()

  const row = page.getByRole('row').filter({ hasText: name })
  await expect(row.getByText('Pending')).toBeVisible()
  // The job pings its URL; the admin list updates live.
  const ping = await request.post(hookUrl)
  expect(ping.ok()).toBeTruthy()
  await expect(row.getByText('Operational')).toBeVisible()

  const unknown = await request.post(hookUrl.replace(/[0-9a-f]+$/, 'deadbeef'))
  expect(unknown.status()).toBe(404)
})

test('a monitor left out of the layout is not published', async ({ page, adminApi }) => {
  const shown = await createHttpMonitor(adminApi, unique('Published service'), HEALTHY_URL)
  const hidden = await createHttpMonitor(adminApi, unique('Internal service'), HEALTHY_URL)
  await setPublicLayout(adminApi, [shown.id])
  await waitUntilPublished({ [shown.id]: null })

  await page.goto(STATUS_URL)
  await expect(page.getByText(shown.name)).toBeVisible()
  await expect(page.getByText(hidden.name)).toHaveCount(0)

  // Not just hidden on the page: the public API does not mention it at all.
  const status = await (await page.request.get(`${API_URL}/api/v1/public/status`)).text()
  expect(status).not.toContain(hidden.name)
  expect((await page.request.get(`${API_URL}/api/v1/public/monitor/${hidden.id}/history`)).status()).toBe(404)
})
