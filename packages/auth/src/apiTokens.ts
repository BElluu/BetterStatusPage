import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { apiTokens } from './tables.js'
import type { AuthOptions } from './context.js'

export function createApiTokens(ctx: AuthOptions) {
  const { db, apiTokenPrefix: API_TOKEN_PREFIX } = ctx
  const parseScopes = ctx.tokens.parse

  const LAST_USED_RESOLUTION_MS = 60_000

  const RATE_LIMIT_PER_MINUTE = 300

  const RATE_WINDOW_MS = 60_000

  function isApiToken(value: string): boolean {
    return value.startsWith(API_TOKEN_PREFIX)
  }

  function hashApiToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  /** 256 random bits, so a plain SHA-256 is enough to store them. The plaintext is shown once and never kept. */
  function generateApiToken(): { token: string; hash: string; prefix: string } {
    const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    return { token, hash: hashApiToken(token), prefix: token.slice(0, API_TOKEN_PREFIX.length + 6) }
  }

  /** The token row when the token may be used right now: it exists and has not expired. */
  async function findUsableApiToken(token: string) {
    const row = (await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hashApiToken(token))))[0]
    if (!row) return null
    const now = Date.now()
    if (row.expiresAt !== null && row.expiresAt <= now) return null
    if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_RESOLUTION_MS) {
      await db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id))
    }
    return row
  }

  const windows = new Map<number, { startedAt: number; count: number }>()

  /** Fixed-window limit per token, so one runaway script cannot starve the API. Returns false once the budget is spent. */
  function consumeApiTokenBudget(tokenId: number, now = Date.now()): boolean {
    const current = windows.get(tokenId)
    if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
      windows.set(tokenId, { startedAt: now, count: 1 })
      return true
    }
    current.count += 1
    return current.count <= RATE_LIMIT_PER_MINUTE
  }

  function resetApiTokenBudgets(): void {
    windows.clear()
  }

  return { parseScopes, isApiToken, hashApiToken, generateApiToken, findUsableApiToken, consumeApiTokenBudget, resetApiTokenBudgets }
}

export type ApiTokens = ReturnType<typeof createApiTokens>
