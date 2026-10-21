export interface McpConfig {
  enabled: boolean
}

/** `MCP_ENABLED` is `true` or `false` (the default); anything else is a mistake worth stopping for. */
export function getMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const raw = env['MCP_ENABLED']?.trim().toLowerCase()
  if (!raw || raw === 'false') return { enabled: false }
  if (raw === 'true') return { enabled: true }
  throw new Error('MCP_ENABLED must be true or false')
}
