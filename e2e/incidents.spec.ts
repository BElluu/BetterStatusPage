import { ADMIN_URL, API_URL, STATUS_URL, checkNow, createHttpMonitor, expect, ok, setPublicLayout, test, unique, waitUntilPublished } from './fixtures'

test('an incident published in the admin panel appears live on the open status page', async ({ browser, adminPage: admin, adminApi }) => {
  const monitor = await createHttpMonitor(adminApi, unique('Payments'), `${API_URL}/health`)
  await checkNow(adminApi, monitor.id)
  await setPublicLayout(adminApi, [monitor.id], { incidents: true })
  await waitUntilPublished({ [monitor.id]: 'up' })

  const visitor = await browser.newPage()
  await visitor.goto(STATUS_URL)
  await expect(visitor.getByText('All systems operational.')).toBeVisible()

  const title = unique('Card payments failing')
  await admin.goto(`${ADMIN_URL}/incidents`)
  await admin.getByRole('button', { name: /New Incident/ }).click()
  await admin.getByPlaceholder('Service degradation').fill(title)
  await admin.getByRole('checkbox', { name: monitor.name }).check()
  await admin.getByRole('button', { name: 'Create Incident' }).click()
  await expect(admin.getByText(title)).toBeVisible()

  // The visitor never reloads: the incident arrives over SSE and marks the linked service.
  await expect(visitor.getByText(title).first()).toBeVisible()
  await expect(visitor.getByText('Incidents in Progress.')).toBeVisible()

  // Resolving it from the timeline clears the banner, again without a reload.
  await admin.getByText(title).click()
  await admin.getByPlaceholder('Describe the current situation…').fill('A fix has been deployed.')
  await admin.locator('select').filter({ has: admin.locator('option[value="resolved"]') }).last().selectOption('resolved')
  await admin.getByRole('button', { name: 'Post Update' }).click()

  await expect(visitor.getByText('All systems operational.')).toBeVisible()
  await visitor.close()
})

test('an incident can be deleted only after confirmation', async ({ adminPage: page, adminApi }) => {
  const title = unique('Stale test incident')
  await ok(adminApi.post('admin/incidents', { data: { title, status: 'investigating', impact: 'minor', monitorIds: [], notifySubscribers: false } }))

  await page.goto(`${ADMIN_URL}/incidents`)
  const row = page.locator('div').filter({ hasText: title }).filter({ has: page.getByRole('button', { name: 'Delete' }) }).last()
  await row.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByText(`Delete "${title}"? This cannot be undone.`)).toBeVisible()
  await page.getByRole('button', { name: 'Delete' }).last().click()
  await expect(page.getByText(title)).toHaveCount(0)
})

test('maintenance: scheduled from the admin panel, shown on the status page while active', async ({ page, adminPage: admin, adminApi }) => {
  const monitor = await createHttpMonitor(adminApi, unique('Database'), `${API_URL}/health`)
  await checkNow(adminApi, monitor.id)

  // A future window created through the form is listed but does not affect the public page yet.
  const upcoming = unique('Planned upgrade')
  await admin.goto(`${ADMIN_URL}/maintenance`)
  await admin.getByRole('button', { name: /Schedule Maintenance/ }).click()
  await admin.getByPlaceholder('Scheduled database maintenance').fill(upcoming)
  await admin.getByRole('checkbox', { name: new RegExp(monitor.name) }).check()
  await admin.getByRole('button', { name: 'Schedule', exact: true }).click()
  await admin.getByRole('button', { name: /^upcoming/ }).click()
  await expect(admin.getByText(upcoming)).toBeVisible()

  await setPublicLayout(adminApi, [monitor.id])
  await waitUntilPublished({ [monitor.id]: 'up' })
  await page.goto(STATUS_URL)
  await expect(page.getByText(monitor.name)).toBeVisible()
  await expect(page.getByText('MAINTENANCE')).toHaveCount(0)

  // A window that is already running marks the affected service.
  const now = Date.now()
  await ok(adminApi.post('admin/maintenance', {
    data: { name: unique('Emergency patch'), startsAt: now - 60_000, endsAt: now + 3_600_000, monitorIds: [monitor.id], notifySubscribers: false },
  }))
  await expect.poll(async () => {
    const status = await (await fetch(`${API_URL}/api/v1/public/status`)).json() as { activeMaintenanceWindows: unknown[] }
    return status.activeMaintenanceWindows.length
  }).toBeGreaterThan(0)
  await page.reload()
  await expect(page.getByText('MAINTENANCE')).toBeVisible()
})
