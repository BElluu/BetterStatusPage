import { registerMcpEndpoint } from '@better-forge/mcp'
import type { FastifyInstance } from 'fastify'
import { MCP_RATE_LIMIT } from '../config/rateLimits.js'
import { auth } from '../kit/auth.js'
import { resolvePublicUrl } from '../kit/runtime.js'
import { getMcpSettings } from '../services/mcpSettings.js'
import { resolveAppVersion } from '../version.js'
import { MCP_INSTRUCTIONS, mcpTools } from './tools.js'
import { mcpWriteTools } from './writeTools.js'

export const MCP_PATH = '/mcp'

/**
 * `POST /mcp`, for agents such as Claude Code. It exists only while an administrator has turned it on (API tokens page); changes need a second switch. Only an API token is accepted: it carries the permissions the tools
 * are limited by, and every tool reads through the admin API with that same token, so what the token may not do is
 * refused there.
 */
export function registerMcp(app: FastifyInstance): void {
  const { apiTokens } = auth
  registerMcpEndpoint(app, {
    path: MCP_PATH,
    name: 'BetterStatusPage',
    version: resolveAppVersion(),
    instructions: MCP_INSTRUCTIONS,
    tools: [...mcpTools, ...mcpWriteTools],
    enabled: async () => (await getMcpSettings()).enabled,
    allowChanges: async () => (await getMcpSettings()).allowChanges,
    publicUrl: () => resolvePublicUrl() || undefined,
    rateLimit: MCP_RATE_LIMIT,
    async authenticate(req) {
      const authorization = req.headers.authorization
      if (!authorization?.startsWith('Bearer ')) return null
      const token = authorization.slice(7)
      if (!apiTokens.isApiToken(token)) return null
      const found = await apiTokens.findUsableApiToken(token)
      return found ? { authorization, scopes: apiTokens.parseScopes(found.scopes) } : null
    },
  })
}
