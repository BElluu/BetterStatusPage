import net from 'net'
import type { PingConfig } from '@bsp/shared'
import type { MonitorStatus } from '@bsp/shared'

function tcpPing(host: string, port: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const socket = new net.Socket()
    socket.setTimeout(timeoutMs)

    socket.on('connect', () => {
      const ms = Date.now() - start
      socket.destroy()
      resolve(ms)
    })
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('TCP connect timed out'))
    })
    socket.on('error', (err) => {
      reject(err)
    })

    socket.connect(port, host)
  })
}

export async function checkPing(
  config: PingConfig,
  timeoutMs: number,
): Promise<{ status: MonitorStatus; responseMs: number | null; error: string | null }> {
  const port = config.port ?? 80
  try {
    const responseMs = await tcpPing(config.host, port, timeoutMs)
    return { status: 'up', responseMs, error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 'down', responseMs: null, error: msg }
  }
}
