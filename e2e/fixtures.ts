import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test as base, expect, request as playwrightRequest, type APIRequestContext, type Browser, type Page } from '@playwright/test'

export const ADMIN_URL = 'http://127.0.0.1:5173/admin'
export const STATUS_URL = 'http://127.0.0.1:5174'
export const API_URL = `http://127.0.0.1:${process.env['E2E_API_PORT'] ?? '3000'}`

export const ADMIN = { email: 'e2e-admin@example.test', password: 'e2e-secure-password' }

export type Role = 'admin' | 'operator' | 'branding'

const authDir = path.join(process.env['E2E_DATA_DIR'] ?? './.e2e', 'auth')
export const stateFile = (role: Role) => path.join(authDir, `${role}.json`)
export const sessionFile = (role: Role) => path.join(authDir, `${role}-session.json`)
export const credentialsFile = (role: Role) => path.join(authDir, `${role}-credentials.json`)

/**
 * The admin app keeps the signed-in user in sessionStorage, which Playwright's storageState does
 * not capture. Cookies come from the saved state; the session entry is replayed before any script.
 */
export async function pageAs(browser: Browser, role: Role): Promise<Page> {
  const context = await browser.newContext({ storageState: stateFile(role) })
  const user = readFileSync(sessionFile(role), 'utf8')
  await context.addInitScript((value) => { window.sessionStorage.setItem('bsp-auth-user', value) }, user)
  return context.newPage()
}

/** An API client signed in as `role`, sending the CSRF header cookie sessions require. */
export async function apiAs(role: Role): Promise<APIRequestContext> {
  const state = JSON.parse(readFileSync(stateFile(role), 'utf8')) as { cookies: Array<{ name: string; value: string }> }
  const csrf = state.cookies.find((cookie) => cookie.name === 'bsp_csrf')?.value ?? ''
  return playwrightRequest.newContext({
    baseURL: `${API_URL}/api/v1/`,
    storageState: stateFile(role),
    extraHTTPHeaders: { 'X-CSRF-Token': csrf },
  })
}

/** Unique names keep scenarios independent of each other and of retries. */
export function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

async function ok<T>(response: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const res = await response
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy()
  return (res.status() === 204 ? undefined : await res.json()) as T
}

export interface MonitorRow { id: number; name: string; currentStatus: string }

export function createHttpMonitor(api: APIRequestContext, name: string, url: string): Promise<MonitorRow> {
  return ok(api.post('admin/monitors', { data: { name, type: 'https', intervalSecs: 3600, config: { url, method: 'GET', expectedStatus: 200 } } }))
}

export function checkNow(api: APIRequestContext, monitorId: number): Promise<unknown> {
  return ok(api.post(`admin/monitors/${monitorId}/check-now`, { data: {} }))
}

/** Replaces the public layout with the given monitors, optionally followed by an incidents block. */
export function setPublicLayout(api: APIRequestContext, monitorIds: number[], options: { incidents?: boolean } = {}): Promise<unknown> {
  const children: unknown[] = monitorIds.map((monitorId, index) => ({
    id: `monitor-${monitorId}`, type: 'monitor', monitorId, showUptimeBar: false, grid: { x: 0, y: index * 2, w: 12, h: 2 },
  }))
  if (options.incidents) {
    children.push({ id: 'incidents', type: 'incidents', filter: 'all', limit: 5, grid: { x: 0, y: monitorIds.length * 2, w: 12, h: 4 } })
  }
  return ok(api.put('admin/layout', { data: { tree: { id: 'root', type: 'page', children } } }))
}

/**
 * `/public/status` is cached for two seconds, so a monitor created moments ago can be missing from
 * the first page load. Wait until the public API includes every monitor before opening the page.
 */
export async function waitUntilPublished(expected: Record<number, string | null>): Promise<void> {
  await expect.poll(async () => {
    const res = await fetch(`${API_URL}/api/v1/public/status`)
    const body = await res.json() as { monitors: Array<{ id: number; currentStatus: string }> }
    const published = new Map(body.monitors.map((monitor) => [monitor.id, monitor.currentStatus]))
    return Object.entries(expected).every(([id, status]) => published.has(Number(id)) && (status === null || published.get(Number(id)) === status))
  }, { timeout: 10_000 }).toBe(true)
}

export { ok }

export const test = base.extend<{ adminPage: Page; adminApi: APIRequestContext }>({
  adminPage: async ({ browser }, provide) => {
    const page = await pageAs(browser, 'admin')
    await provide(page)
    await page.context().close()
  },
  // Playwright requires an object pattern here even when the fixture has no dependencies.
  // eslint-disable-next-line no-empty-pattern
  adminApi: async ({}, provide) => {
    const api = await apiAs('admin')
    await provide(api)
    await api.dispose()
  },
})

export { expect }
