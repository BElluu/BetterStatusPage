import net from 'net'
import ping from 'ping'
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

// The system ping reports a local permission problem on its output, which would otherwise read
// like an unreachable host. Covers busybox, iputils and BSD wording.
const ICMP_DENIED = /permission denied|operation not permitted|lacking privilege/i

const ICMP_DENIED_ERROR =
  'ICMP is not permitted for the server process. Allow unprivileged ICMP with the ' +
  'net.ipv4.ping_group_range sysctl (see the Ping / TCP monitor docs) or use TCP mode.'

const ICMP_MISSING_ERROR =
  'The ping command could not be run on the server. Install it (iputils-ping) or use TCP mode.'

async function icmpPing(host: string, timeoutMs: number): Promise<number> {
  let result: Awaited<ReturnType<typeof ping.promise.probe>>
  try {
    result = await ping.promise.probe(host, {
      timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
      min_reply: 1,
    })
  } catch {
    throw new Error(ICMP_MISSING_ERROR)
  }
  if (!result.alive) {
    if (ICMP_DENIED.test(result.output)) throw new Error(ICMP_DENIED_ERROR)
    throw new Error(result.output || 'ICMP host is unreachable')
  }
  return typeof result.time === 'number' ? result.time : Number.parseFloat(result.time) || 0
}

export async function checkPing(
  config: PingConfig,
  timeoutMs: number,
): Promise<{ status: MonitorStatus; responseMs: number | null; error: string | null }> {
  const port = config.port ?? 80
  try {
    let responseMs: number
    if (config.mode === 'icmp') {
      responseMs = await icmpPing(config.host, timeoutMs)
    } else {
      responseMs = await tcpPing(config.host, port, timeoutMs)
    }
    return { status: 'up', responseMs, error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 'down', responseMs: null, error: msg }
  }
}
