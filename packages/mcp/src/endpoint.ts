import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { tokenAllows } from '@better-forge/contracts'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from 'fastify'
import { crossSiteProblem } from './guard.js'
import { boundedJson, cleanDeep, McpToolError, cleanText } from './output.js'
import { SAFE_PATH, type McpTool, type McpToolContext } from './tools.js'

/** Who is calling: the permissions of the token and the header to hand on to the host's own API. */
export interface McpCaller {
  authorization: string
  scopes: readonly string[]
}

export interface McpEndpointOptions {
  /** Path of the endpoint. */
  path: string
  name: string
  version: string
  /** Shown to the agent once, when it connects. Static text; nothing that came from the data belongs here. */
  instructions: string
  tools: readonly McpTool[]
  /** The caller behind a `Bearer` token, or null. Cookies are never looked at: a browser must not be able to use this endpoint. */
  authenticate(req: FastifyRequest): Promise<McpCaller | null>
  /** Whether the endpoint answers at all. Asked first on every request: when false it is indistinguishable from a path that does not exist. */
  enabled(): boolean | Promise<boolean>
  /** Whether tools that change data are offered. When false a caller sees only the read-only ones, whatever its token may do. */
  allowChanges(): boolean | Promise<boolean>
  /** The address visitors use; known only when configured. */
  publicUrl(): string | undefined
  /** Options of @fastify/rate-limit for the route. */
  rateLimit?: Record<string, unknown>
}

const MAX_BODY_BYTES = 256 * 1024

/** The caller's view of the host's API: each call is a request to the same app, so its checks, limits and audit apply unchanged. */
function contextFor(app: FastifyInstance, caller: McpCaller): McpToolContext {
  return {
    can: (scope) => tokenAllows(caller.scopes, scope),
    get: (path) => request('GET', path),
    send: (method, path, body, contentType) => {
      // The types already say so; this holds when a tool is written loosely.
      if (!['POST', 'PATCH', 'PUT'].includes(method)) throw new McpToolError('A tool tried to send a request that is not allowed')
      return request(method, path, body, contentType)
    },
  }

  async function request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: unknown, bodyType?: string): Promise<unknown> {
    const [path = '', ...query] = url.split('?')
    // A request that changes data has no query: a tool must not be able to reach, say, an apply with a flag that deletes.
    const allowed = ['GET', 'POST', 'PATCH', 'PUT'].includes(method) && SAFE_PATH.test(path) && !path.includes('..') && (method === 'GET' || query.length === 0)
    if (!allowed) throw new McpToolError('A tool tried to send a request that is not allowed')
    const headers: Record<string, string> = { authorization: caller.authorization }
    if (bodyType) headers['content-type'] = bodyType
    const response = await app.inject({
      method, url, headers,
      ...(method === 'GET' ? {} : { payload: bodyType ? String(body) : (body as object | undefined) ?? {} }),
    })
    const contentType = String(response.headers['content-type'] ?? '')
    if (response.statusCode >= 400) {
      const failure = contentType.includes('json') ? (response.json() as { error?: unknown; problems?: unknown }) : {}
      const problems = Array.isArray(failure.problems) ? ` ${JSON.stringify(failure.problems).slice(0, 1500)}` : ''
      throw new McpToolError(`${response.statusCode}: ${typeof failure.error === 'string' ? cleanText(failure.error) : 'The request failed'}${cleanText(problems)}`)
    }
    if (response.statusCode === 204) return { ok: true }
    return contentType.includes('json') ? response.json() : response.body
  }
}

function annotationsFor(access: McpTool['access']) {
  return access === 'read'
    ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    : { readOnlyHint: false, destructiveHint: access === 'destructive', idempotentHint: false, openWorldHint: false }
}

function serverFor(app: FastifyInstance, options: McpEndpointOptions, caller: McpCaller, allowChanges: boolean): McpServer {
  const server = new McpServer({ name: options.name, version: options.version }, { instructions: options.instructions })
  const context = contextFor(app, caller)
  for (const tool of options.tools) {
    if (!tokenAllows(caller.scopes, tool.scope)) continue
    if (tool.access !== 'read' && !allowChanges) continue
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Strict: an argument that does not exist is an error the agent sees, not a change that silently did not happen.
        inputSchema: z.strictObject(tool.input),
        annotations: annotationsFor(tool.access),
      },
      async (args: unknown) => {
        try {
          const data = await (tool.handler as (args: unknown, ctx: McpToolContext) => Promise<unknown>)(args, context)
          return { content: [{ type: 'text' as const, text: boundedJson(cleanDeep(data)) }] }
        } catch (error) {
          // A refused or failed request is the tool's answer; anything unexpected is reported without its details.
          const text = error instanceof McpToolError ? error.message : 'The tool failed'
          return { isError: true, content: [{ type: 'text' as const, text }] }
        }
      },
    )
  }
  return server
}

/**
 * Registers `POST <path>`: the MCP Streamable HTTP transport in its stateless form (a request carries everything, no
 * session is kept). The route accepts a `Bearer` token only and lists just the tools that token may use.
 */
export function registerMcpEndpoint(app: FastifyInstance, options: McpEndpointOptions): void {
  // First of everything, before authentication and before the body is read: an endpoint that is off leaks nothing.
  const gate: onRequestAsyncHookHandler = async (_req, reply) => {
    let on = false
    try { on = await options.enabled() } catch { /* not ready: off */ }
    if (!on) return reply.callNotFound()
  }

  app.route({
    method: ['GET', 'DELETE'],
    url: options.path,
    onRequest: gate,
    handler: (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'Use POST' }),
  })

  app.post(options.path, { onRequest: gate, bodyLimit: MAX_BODY_BYTES, config: { rateLimit: options.rateLimit } }, async (req, reply) => {
    const problem = crossSiteProblem(req.headers, options.publicUrl())
    if (problem) return reply.code(403).send({ error: problem })

    // One call per request: a batch would spend one rate-limit hit on up to a hundred calls.
    if (Array.isArray(req.body)) return reply.code(400).send({ error: 'Batched requests are not accepted' })

    let caller: McpCaller | null = null
    try { caller = await options.authenticate(req) } catch { /* not signed in */ }
    if (!caller) return reply.code(401).header('www-authenticate', 'Bearer realm="mcp"').send({ error: 'Unauthorized' })

    // Not knowing is not allowing.
    let allowChanges = false
    try { allowChanges = await options.allowChanges() } catch { /* read-only */ }
    const server = serverFor(app, options, caller, allowChanges)
    // Without a session id generator the transport is stateless.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    // The transport writes the response itself, so Fastify's own hooks no longer run: set what they would.
    reply.hijack()
    const res = reply.raw
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('cache-control', 'no-store')
    res.on('close', () => { void transport.close(); void server.close() })
    try {
      // The SDK's own transport type does not satisfy exactOptionalPropertyTypes.
      await server.connect(transport as unknown as Parameters<McpServer['connect']>[0])
      await transport.handleRequest(req.raw, res, req.body)
    } catch {
      if (res.headersSent) res.destroy()
      else {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }))
      }
    }
  })
}
