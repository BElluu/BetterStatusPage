import type { z } from 'zod'

/** What a tool may do with the host application: read its own API with the credentials of the caller. */
export interface McpToolContext {
  /** True when the caller's token holds the permission. */
  can(scope: string): boolean
  /** GET a path of the host application's API (`/api/v1/admin/monitors`); JSON comes back parsed, anything else as text. */
  get(path: string): Promise<unknown>
  /** POST, PATCH or PUT a body (JSON, or text when `contentType` is given) to a path of the host's API. Nothing else can be sent: no DELETE. */
  send(method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown, contentType?: string): Promise<unknown>
}

/**
 * What a tool does to the data: `read` changes nothing; `write` changes something that can be changed back or that
 * nobody sees yet; `destructive` is visible to other people or cannot be undone (an agent client asks first).
 */
export type McpAccess = 'read' | 'write' | 'destructive'

/** Where a tool may send a request: a path of the host, nothing that could leave it or change its meaning. */
export const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9_\-./]*$/

export interface McpTool {
  name: string
  title: string
  description: string
  /** The permission a token needs to see and call the tool. */
  scope: string
  access: McpAccess
  input: z.ZodRawShape
  handler(args: never, ctx: McpToolContext): Promise<unknown>
}

export interface McpToolDefinition<Shape extends z.ZodRawShape> {
  name: string
  title: string
  description: string
  scope: string
  /** Defaults to `read`. */
  access?: McpAccess
  input: Shape
  handler(args: z.infer<z.ZodObject<Shape>>, ctx: McpToolContext): Promise<unknown>
}

export function defineTool<Shape extends z.ZodRawShape>(definition: McpToolDefinition<Shape>): McpTool {
  return { access: 'read', ...definition } as unknown as McpTool
}

/** Query string from the values that were given. */
export function query(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value))
  const text = params.toString()
  return text ? `?${text}` : ''
}
