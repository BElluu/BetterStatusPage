export interface DockerEndpoint {
  origin: string
  /** Unix socket path or local Windows named pipe; absent for TCP endpoints. */
  socketPath?: string
}

/** Docker container names and IDs; also keeps `.` and `..` out of the request path. */
export const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const LOCAL_PIPE = /^npipe:\/\/\/\/\.\/pipe\/([A-Za-z0-9_.-]+)$/

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
