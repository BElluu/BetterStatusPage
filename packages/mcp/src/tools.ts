import type { z } from 'zod'

/** What a tool may do with the host application: read its own API with the credentials of the caller. */
export interface McpToolContext {
  /** True when the caller's token holds the permission. */
  can(scope: string): boolean
  /** GET a path of the host application's API (`/api/v1/admin/monitors`); JSON comes back parsed, anything else as text. */
  get(path: string): Promise<unknown>
}

export interface McpTool {
  name: string
  title: string
  description: string
  /** The permission a token needs to see and call the tool. */
  scope: string
  input: z.ZodRawShape
  handler(args: never, ctx: McpToolContext): Promise<unknown>
}

export interface McpToolDefinition<Shape extends z.ZodRawShape> {
  name: string
  title: string
  description: string
  scope: string
  input: Shape
  handler(args: z.infer<z.ZodObject<Shape>>, ctx: McpToolContext): Promise<unknown>
}

/** Every tool reads: nothing here changes data, so each is announced as read-only. */
export function defineTool<Shape extends z.ZodRawShape>(definition: McpToolDefinition<Shape>): McpTool {
  return definition as unknown as McpTool
}

/** Query string from the values that were given. */
export function query(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value))
  const text = params.toString()
  return text ? `?${text}` : ''
}
