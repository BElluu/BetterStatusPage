import { Agent, request } from 'undici'
import type { DockerConfig, MonitorStatus } from '@bsp/shared'

export interface ContainerState {
  running: boolean
  paused: boolean
  restarting: boolean
  /** Docker status string: running, exited, created, ... */
  status: string
  /** Healthcheck result; null when the container defines no healthcheck. */
  health: string | null
}

export interface DockerEndpoint {
  origin: string
  /** Unix socket path or local Windows named pipe; absent for TCP endpoints. */
  socketPath?: string
}

/** Docker container names and IDs; also keeps `.` and `..` out of the request path. */
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const LOCAL_PIPE = /^npipe:\/\/\/\/\.\/pipe\/([A-Za-z0-9_.-]+)$/
const MAX_RESPONSE_BYTES = 1024 * 1024

/**
 * Parses the endpoint without connecting. unix:///path (POSIX only) and npipe:////./pipe/name
 * (local pipes only, never a remote UNC path) use a socket path; http(s)://host:port must be a bare
 * origin, so the API path stays under our control.
 */
export function parseDockerEndpoint(endpoint: string): DockerEndpoint {
  const value = endpoint.trim()
  if (value.startsWith('unix://')) {
    const socketPath = value.slice('unix://'.length)
    if (process.platform === 'win32') throw new Error('unix:// endpoints are not supported on Windows; use npipe:////./pipe/docker_engine')
    if (!socketPath.startsWith('/') || socketPath.startsWith('//')) throw new Error('unix:// endpoint needs an absolute socket path')
    return { origin: 'http://docker', socketPath }
  }
  if (value.startsWith('npipe://')) {
    const match = LOCAL_PIPE.exec(value)
    if (!match) throw new Error('npipe:// endpoint must be a local pipe, e.g. npipe:////./pipe/docker_engine')
    return { origin: 'http://docker', socketPath: `\\\\.\\pipe\\${match[1]}` }
  }
  if (/^https?:\/\//i.test(value)) {
    let url: URL
    try { url = new URL(value) } catch { throw new Error('Endpoint is not a valid URL') }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('HTTP(S) endpoint must be just scheme, host and port, e.g. http://host:2375')
    }
    return { origin: url.origin }
  }
  throw new Error('Endpoint must start with unix://, npipe://, http:// or https://')
}

/** Returns a message when the config cannot be checked, or null when it is valid. */
export function validateDockerConfig(config: unknown): string | null {
  if (typeof config !== 'object' || config === null) return 'Docker config must be an object'
  const { endpoint, container } = config as Partial<DockerConfig>
  if (typeof container !== 'string' || !container.trim()) return 'Container name or ID is required'
  if (!CONTAINER_NAME.test(container.trim())) return 'Container name may only contain letters, digits, "_", "." and "-"'
  try {
    parseDockerEndpoint(typeof endpoint === 'string' ? endpoint : '')
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return null
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
  const dispatcher = socketPath ? new Agent({ connect: { socketPath } }) : undefined
  try {
    const res = await request(`${origin}/containers/${encodeURIComponent(config.container.trim())}/json`, {
      method: 'GET',
      ...(dispatcher ? { dispatcher } : {}),
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
    await dispatcher?.close()
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
