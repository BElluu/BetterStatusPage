import { Agent, request } from 'undici'
import { guardedAgent } from '../services/ssrfGuard.js'
import type { DockerConfig, MonitorStatus } from '@bsp/shared'
import { validateMonitorConfig } from '../services/monitorConfigSchema.js'
import { parseDockerEndpoint } from './dockerEndpoint.js'

export { parseDockerEndpoint, type DockerEndpoint } from './dockerEndpoint.js'

export interface ContainerState {
  running: boolean
  paused: boolean
  restarting: boolean
  /** Docker status string: running, exited, created, ... */
  status: string
  /** Healthcheck result; null when the container defines no healthcheck. */
  health: string | null
}

const MAX_RESPONSE_BYTES = 1024 * 1024

/** Returns a message when the config cannot be checked, or null when it is valid. */
export function validateDockerConfig(config: unknown): string | null {
  if (typeof config !== 'object' || config === null) return 'Docker config must be an object'
  return validateMonitorConfig('docker', config)
}

async function readLimited(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    size += chunk.length
    if (size > MAX_RESPONSE_BYTES) throw new Error('Docker API response is too large')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function inspectContainer(config: DockerConfig, timeoutMs: number): Promise<ContainerState | null> {
  const invalid = validateDockerConfig(config)
  if (invalid) throw new Error(invalid)
  const { origin, socketPath } = parseDockerEndpoint(config.endpoint)
  // A TCP endpoint is an address someone typed in; the shared guarded agent outlives the call, a socket agent does not.
  const socketAgent = socketPath ? new Agent({ connect: { socketPath } }) : undefined
  try {
    const res = await request(`${origin}/containers/${encodeURIComponent(config.container.trim())}/json`, {
      method: 'GET',
      dispatcher: socketAgent ?? guardedAgent,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.statusCode === 404) { await res.body.dump(); return null }
    if (res.statusCode !== 200) {
      await res.body.dump()
      throw new Error(`Docker API returned HTTP ${res.statusCode}`)
    }
    const text = await readLimited(res.body)
    let body: { State?: { Status?: string; Running?: boolean; Paused?: boolean; Restarting?: boolean; Health?: { Status?: string } } }
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error('Docker API returned a non-JSON response')
    }
    const state = body.State ?? {}
    return {
      running: state.Running === true,
      paused: state.Paused === true,
      restarting: state.Restarting === true,
      status: state.Status ?? 'unknown',
      health: state.Health?.Status ?? null,
    }
  } finally {
    await socketAgent?.close()
  }
}

/** up = running (and healthy when a healthcheck exists), degraded = restarting/unhealthy/starting, down = anything else. */
export function evaluateContainer(state: ContainerState | null, container: string): { status: MonitorStatus; error: string | null } {
  if (!state) return { status: 'down', error: `Container "${container}" not found` }
  if (state.paused) return { status: 'down', error: 'Container is paused' }
  if (state.restarting) return { status: 'degraded', error: 'Container is restarting' }
  if (!state.running) return { status: 'down', error: `Container is not running (${state.status})` }
  if (state.health && state.health !== 'healthy') return { status: 'degraded', error: `Container health is ${state.health}` }
  return { status: 'up', error: null }
}

export async function checkDocker(
  config: DockerConfig,
  timeoutMs: number,
): Promise<{ status: MonitorStatus; responseMs: number | null; error: string | null }> {
  const start = Date.now()
  try {
    const state = await inspectContainer(config, timeoutMs)
    const { status, error } = evaluateContainer(state, config.container)
    return { status, responseMs: Date.now() - start, error }
  } catch (err) {
    return { status: 'down', responseMs: null, error: err instanceof Error ? err.message : String(err) }
  }
}
