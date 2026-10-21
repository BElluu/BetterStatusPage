import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { tokenAllows } from '@better-kit/contracts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { crossSiteProblem } from './guard.js'
import { boundedJson, cleanDeep, McpToolError, cleanText } from './output.js'
import type { McpTool, McpToolContext } from './tools.js'

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
    async get(path) {
      const response = await app.inject({ method: 'GET', url: path, headers: { authorization: caller.authorization } })
      const contentType = String(response.headers['content-type'] ?? '')
      if (response.statusCode >= 400) {
        const reason = contentType.includes('json') ? (response.json() as { error?: unknown }).error : undefined
        throw new McpToolError(`${response.statusCode}: ${typeof reason === 'string' ? cleanText(reason) : 'The request failed'}`)
      }
      return contentType.includes('json') ? response.json() : response.body
    },
  }
}

function serverFor(app: FastifyInstance, options: McpEndpointOptions, caller: McpCaller): McpServer {
  const server = new McpServer({ name: options.name, version: options.version }, { instructions: options.instructions })
  const context = contextFor(app, caller)
  for (const tool of options.tools) {
    if (!tokenAllows(caller.scopes, tool.scope)) continue
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
  app.route({
    method: ['GET', 'DELETE'],
    url: options.path,
    handler: (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'Use POST' }),
  })

  app.post(options.path, { bodyLimit: MAX_BODY_BYTES, config: { rateLimit: options.rateLimit } }, async (req, reply) => {
    const problem = crossSiteProblem(req.headers, options.publicUrl())
    if (problem) return reply.code(403).send({ error: problem })

    let caller: McpCaller | null = null
    try { caller = await options.authenticate(req) } catch { /* not signed in */ }
    if (!caller) return reply.code(401).header('www-authenticate', 'Bearer realm="mcp"').send({ error: 'Unauthorized' })

    const server = serverFor(app, options, caller)
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
