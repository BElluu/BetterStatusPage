import bcrypt from 'bcryptjs'
import { and, eq, gt } from 'drizzle-orm'
import type { FastifyReply } from 'fastify'
import { db } from '../db/client.js'
import { authSessions, users } from '../db/schema.js'
import type { AuthIdentity } from './authSession.js'

/** Error code telling the admin UI to confirm the user through the identity provider, then retry. */
export const SSO_CONFIRMATION_REQUIRED = 'SSO_CONFIRMATION_REQUIRED'
/** How long an SSO sign-in or SSO confirmation covers sensitive actions in that session. */
export const SSO_CONFIRMATION_WINDOW_MS = 10 * 60 * 1000

/**
 * Sensitive actions are confirmed the way the session signed in: a password session with the current
 * password, an SSO session with a recent sign-in at the identity provider (the sign-in itself, or a
 * confirmation popup started from the UI). Returns true, or sends the refusal and returns false.
 */
export async function confirmIdentity(identity: AuthIdentity, currentPassword: unknown, reply: FastifyReply): Promise<boolean> {
  if (identity.authMethod === 'oidc') {
    const session = (await db.select().from(authSessions).where(eq(authSessions.id, identity.sessionId)))[0]
    const verifiedAt = session?.verifiedAt ?? session?.createdAt ?? 0
    if (Date.now() - verifiedAt <= SSO_CONFIRMATION_WINDOW_MS) return true
    await reply.code(403).send({ error: 'Confirm your identity with single sign-on to continue', code: SSO_CONFIRMATION_REQUIRED })
    return false
  }
  const user = (await db.select().from(users).where(eq(users.id, identity.userId)))[0]
  if (user && typeof currentPassword === 'string' && currentPassword && await bcrypt.compare(currentPassword, user.passwordHash)) return true
  await reply.code(400).send({ error: 'Current password is incorrect' })
  return false
}

/** Records a successful SSO confirmation on a live SSO session of that user. False when there is no such session. */
export async function markSessionVerified(sessionId: string, userId: number): Promise<boolean> {
  const updated = await db.update(authSessions).set({ verifiedAt: Date.now() }).where(and(
    eq(authSessions.id, sessionId),
    eq(authSessions.userId, userId),
    eq(authSessions.authMethod, 'oidc'),
    gt(authSessions.expiresAt, Date.now()),
  )).returning({ id: authSessions.id })
  return updated.length > 0
}
