import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, lt, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import { authSessions, users } from '../db/schema.js'

export const SESSION_COOKIE = 'bsp_session'
export const CSRF_COOKIE = 'bsp_csrf'
const SESSION_SECONDS = 12 * 60 * 60

export interface AuthIdentity {
  userId: number
  email: string
  role: string
  sessionId: string
  mustChangePassword: boolean
  twoFactorEnabled: boolean
}

interface SessionClaims {
  userId: number
  email: string
  role: string
  sessionId: string
}

function cookieOptions(httpOnly: boolean) {
  return {
    path: '/',
    httpOnly,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'strict' as const,
    maxAge: SESSION_SECONDS,
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function normalizedRole(role: string): string {
  return ['admin', 'operator', 'branding'].includes(role) ? role : 'branding'
}

export async function createAuthSession(
  app: FastifyInstance,
  reply: FastifyReply,
  user: { id: number; email: string; role: string; mustChangePassword: number; totpEnabled: number },
): Promise<AuthIdentity> {
  const now = Date.now()
  const sessionId = randomUUID()
  const csrfToken = randomBytes(32).toString('base64url')
  const expiresAt = now + SESSION_SECONDS * 1000
  await db.delete(authSessions).where(lt(authSessions.expiresAt, now))
  await db.insert(authSessions).values({
    id: sessionId,
    userId: user.id,
    csrfTokenHash: hash(csrfToken),
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
  })

  const role = normalizedRole(user.role)
  const token = app.jwt.sign({ userId: user.id, email: user.email, role, sessionId })
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(true))
  reply.setCookie(CSRF_COOKIE, csrfToken, cookieOptions(false))
  return {
    userId: user.id,
    email: user.email,
    role,
    sessionId,
    mustChangePassword: !!user.mustChangePassword,
    twoFactorEnabled: !!user.totpEnabled,
  }
}

export function clearAuthCookies(reply: FastifyReply): void {
  const base = { path: '/', secure: process.env['NODE_ENV'] === 'production', sameSite: 'strict' as const }
  reply.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true })
  reply.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false })
}

function requestToken(req: FastifyRequest): string | null {
  const authorization = req.headers.authorization
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7)
  return req.cookies[SESSION_COOKIE] ?? null
}

export async function authenticateRequest(req: FastifyRequest): Promise<AuthIdentity> {
  const token = requestToken(req)
  if (!token) throw new Error('Missing session')
  const claims = req.server.jwt.verify<SessionClaims>(token)
  if (!claims.sessionId || !Number.isInteger(claims.userId)) throw new Error('Invalid session')

  const now = Date.now()
  const session = (await db.select().from(authSessions).where(eq(authSessions.id, claims.sessionId)))[0]
  if (!session || session.userId !== claims.userId || session.expiresAt <= now) {
    if (session) await db.delete(authSessions).where(eq(authSessions.id, session.id))
    throw new Error('Expired session')
  }
  const user = (await db.select().from(users).where(eq(users.id, claims.userId)))[0]
  if (!user) throw new Error('Unknown user')

  if (now - session.lastSeenAt >= 60_000) {
    await db.update(authSessions).set({ lastSeenAt: now }).where(eq(authSessions.id, session.id))
  }
  const identity: AuthIdentity = {
    userId: user.id,
    email: user.email,
    role: normalizedRole(user.role),
    sessionId: session.id,
    mustChangePassword: !!user.mustChangePassword,
    twoFactorEnabled: !!user.totpEnabled,
  }
  req.user = identity
  return identity
}

export async function verifyCsrf(req: FastifyRequest, identity: AuthIdentity): Promise<void> {
  if (req.headers.authorization?.startsWith('Bearer ')) return
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return
  const cookie = req.cookies[CSRF_COOKIE]
  const header = req.headers['x-csrf-token']
  if (!cookie || typeof header !== 'string' || !equalHash(hash(cookie), hash(header))) {
    throw new Error('Invalid CSRF token')
  }
  const session = (await db.select({ csrfTokenHash: authSessions.csrfTokenHash })
    .from(authSessions).where(eq(authSessions.id, identity.sessionId)))[0]
  if (!session || !equalHash(session.csrfTokenHash, hash(header))) throw new Error('Invalid CSRF token')
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.id, sessionId))
}

export async function revokeUserSessions(userId: number, exceptSessionId?: string): Promise<void> {
  const condition = exceptSessionId
    ? and(eq(authSessions.userId, userId), ne(authSessions.id, exceptSessionId))
    : eq(authSessions.userId, userId)
  await db.delete(authSessions).where(condition)
}
