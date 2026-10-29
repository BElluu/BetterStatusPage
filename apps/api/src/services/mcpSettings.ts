import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { mcpSettings } from '../db/schema.js'

export interface McpSettings {
  /** /mcp answers. Off: it does not exist. */
  enabled: boolean
  /** Tools that change data are offered, to tokens that may write. Only ever true while enabled. */
  allowChanges: boolean
}

const OFF: McpSettings = { enabled: false, allowChanges: false }

/** Read on every request: one row, and a change then applies at once. Before the database exists, MCP is off. */
export async function getMcpSettings(): Promise<McpSettings> {
  try {
    const row = (await db.select().from(mcpSettings).where(eq(mcpSettings.id, 1)))[0]
    return row ? { enabled: !!row.enabled, allowChanges: !!row.enabled && !!row.allowChanges } : OFF
  } catch {
    return OFF
  }
}

/** Turning MCP off also turns the changes off, so it comes back read-only until someone decides again. */
export async function saveMcpSettings(next: McpSettings): Promise<McpSettings> {
  const saved: McpSettings = { enabled: next.enabled, allowChanges: next.enabled && next.allowChanges }
  const values = { enabled: saved.enabled ? 1 : 0, allowChanges: saved.allowChanges ? 1 : 0, updatedAt: Date.now() }
  await db.insert(mcpSettings).values({ id: 1, ...values }).onConflictDoUpdate({ target: mcpSettings.id, set: values })
  return saved
}
