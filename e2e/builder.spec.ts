import type { Locator, Page } from '@playwright/test'
import { ADMIN_URL, API_URL, createHttpMonitor, expect, ok, test, unique } from './fixtures'

interface Tree { children: Array<{ id: string; type: string; children?: Array<{ id: string }> }> }

/** Drags with real mouse moves in small steps, as the grid and dnd-kit only react to movement. */
async function drag(page: Page, from: Locator, to: { x: number; y: number }, onTheWay?: () => Promise<void>) {
  const box = (await from.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 25 })
  await onTheWay?.()
  await page.mouse.up()
}

test('moves canvas monitors into a group and group monitors back out', async ({ adminPage: page, adminApi }) => {
  const grouped = await createHttpMonitor(adminApi, unique('Grouped'), `${API_URL}/health`)
  const loose = await createHttpMonitor(adminApi, unique('Loose'), `${API_URL}/health`)
  await ok(adminApi.put('admin/layout', {
    data: {
      tree: {
        id: 'root', type: 'page', children: [
          { id: 'g1', type: 'group', label: 'Core', collapsible: false, grid: { x: 0, y: 0, w: 2, h: 3 },
            children: [{ id: 'gm', type: 'monitor', monitorId: grouped.id, showUptimeBar: true }] },
          { id: 'lm', type: 'monitor', monitorId: loose.id, showUptimeBar: true, grid: { x: 0, y: 3, w: 1, h: 1 } },
        ],
      },
    },
  }))
  await page.goto(`${ADMIN_URL}/builder`)
  const group = page.locator('[data-group-id="g1"]')
  await expect(group.getByText(grouped.name)).toBeVisible()

  // Into the group: the group lights up instead of the grid placeholder, and stays where it is.
  const groupBox = (await group.boundingBox())!
  const looseHandle = page.getByRole('button', { name: `Monitor ${loose.name}` }).locator('.drag-handle')
  await drag(page, looseHandle, { x: groupBox.x + groupBox.width / 2, y: groupBox.y + groupBox.height / 2 }, async () => {
    await expect(group.getByText('Drop here')).toBeVisible()
    await expect(page.locator('.react-grid-placeholder')).toBeHidden()
    expect((await group.boundingBox())!.y).toBeCloseTo(groupBox.y, 0)
  })
  await expect(group.getByText(loose.name)).toBeVisible()

  // Out of the group: the grid placeholder shows where it will land.
  const canvas = (await page.locator('[data-group-id="g1"]').locator('xpath=ancestor::div[contains(@class,"react-grid-layout")]').boundingBox())!
  const target = { x: canvas.x + canvas.width * 0.85, y: groupBox.y + 20 }
  await drag(page, group.getByRole('button', { name: `Reorder Monitor ${grouped.name}` }), target, async () => {
    await expect(page.locator('.react-grid-placeholder')).toBeVisible()
  })
  await expect(group.getByText(grouped.name)).toBeHidden()

  // dnd-kit swallows the click that follows a drop; a person never clicks that fast.
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved!')).toBeVisible()
  const saved = await ok<Tree>(adminApi.get('admin/layout'))
  const savedGroup = saved.children.find((node) => node.id === 'g1')!
  expect(savedGroup.children!.map((child) => child.id)).toEqual(['lm'])
  expect(saved.children.some((node) => node.id === 'gm')).toBe(true)
})
