import type { HttpsConfig } from '@bsp/shared'
import type { MonitorStatus } from '@bsp/shared'

export async function checkHttps(
  config: HttpsConfig,
  timeoutMs: number,
): Promise<{ status: MonitorStatus; responseMs: number | null; error: string | null }> {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const res = await fetch(config.url, {
      method: config.method ?? 'GET',
      headers: config.headers ?? {},
      signal: controller.signal,
      redirect: 'follow',
    })
    clearTimeout(timer)

    const responseMs = Date.now() - start
    const expectedStatus = config.expectedStatus ?? 200

    if (res.status !== expectedStatus) {
      return {
        status: 'down',
        responseMs,
        error: `Expected HTTP ${expectedStatus}, got ${res.status}`,
      }
    }

    if (config.keyword) {
      const body = await res.text()
      if (!body.includes(config.keyword)) {
        return {
          status: 'degraded',
          responseMs,
          error: `Keyword "${config.keyword}" not found in response body`,
        }
      }
    }

    return { status: 'up', responseMs, error: null }
  } catch (err) {
    const responseMs = Date.now() - start
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 'down', responseMs, error: msg }
  }
}
