import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { apiTokens, users } from '../db/schema.js'
import { normalizeRole } from './roles.js'

export const API_TOKEN_PREFIX = 'bsp_'
/** Roles a token can carry; `viewer` has no admin access, so there is nothing to grant. */
export const API_TOKEN_ROLES = ['admin', 'operator', 'branding'] as const
export type ApiTokenRole = typeof API_TOKEN_ROLES[number]

const LAST_USED_RESOLUTION_MS = 60_000
const RATE_LIMIT_PER_MINUTE = 300
const RATE_WINDOW_MS = 60_000

export function isApiToken(value: string): boolean {
  return value.startsWith(API_TOKEN_PREFIX)
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 256 random bits, so a plain SHA-256 is enough to store them. The plaintext is shown once and never kept. */
export function generateApiToken(): { token: string; hash: string; prefix: string } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  return { token, hash: hashApiToken(token), prefix: token.slice(0, API_TOKEN_PREFIX.length + 6) }
}

/**
 * The token row and its owner when the token may be used right now: it exists, has not expired, and its creator
 * is still an administrator. A demoted or deleted admin therefore takes their tokens down with them.
 */
export async function findUsableApiToken(token: string) {
  const row = (await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hashApiToken(token))))[0]
  if (!row) return null
  const now = Date.now()
  if (row.expiresAt !== null && row.expiresAt <= now) return null
  const owner = (await db.select().from(users).where(eq(users.id, row.userId)))[0]
  if (!owner || normalizeRole(owner.role) !== 'admin') return null
  if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_RESOLUTION_MS) {
    await db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id))
  }
  return { token: row, owner }
}

const windows = new Map<number, { startedAt: number; count: number }>()

/** Fixed-window limit per token, so one runaway script cannot starve the API. Returns false once the budget is spent. */
export function consumeApiTokenBudget(tokenId: number, now = Date.now()): boolean {
  const current = windows.get(tokenId)
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    windows.set(tokenId, { startedAt: now, count: 1 })
    return true
  }
  current.count += 1
  return current.count <= RATE_LIMIT_PER_MINUTE
}

export function resetApiTokenBudgets(): void {
  windows.clear()
}
