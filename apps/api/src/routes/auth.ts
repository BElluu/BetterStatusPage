import type { FastifyInstance, FastifyReply } from 'fastify'
import bcrypt from 'bcryptjs'
import QRCode from 'qrcode'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { LOGIN_RATE_LIMIT } from '../config/rateLimits.js'
import { decrypt, encrypt } from '../crypto/vault.js'
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  totpUri,
  verifyTotp,
} from '../crypto/totp.js'
import { requireAuth } from '../middleware/auth.js'
import {
  clearAuthCookies,
  createAuthSession,
  revokeSession,
  revokeUserSessions,
  type AuthIdentity,
} from '../services/authSession.js'
import { writeAudit } from '../services/audit.js'
import { verifySecondFactor } from '../services/twoFactor.js'

function publicSession(identity: AuthIdentity) {
  const { sessionId: _sessionId, ...safe } = identity
  return safe
}

async function verifyPassword(user: typeof users.$inferSelect, password: string): Promise<boolean> {
  return bcrypt.compare(password, user.passwordHash)
}

async function finishLogin(app: FastifyInstance, reply: FastifyReply, user: typeof users.$inferSelect) {
  const identity = await createAuthSession(app, reply, user)
  return publicSession(identity)
}

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { email: string; password: string } }>('/login', {
    config: { rateLimit: LOGIN_RATE_LIMIT },
  }, async (req, reply) => {
    const { email, password } = req.body
    const user = (await db.select().from(users).where(eq(users.email, email)))[0]
    if (!user || !await verifyPassword(user, password)) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }
    if (user.totpEnabled) {
      const challengeToken = app.jwt.sign({ purpose: 'two-factor-login', userId: user.id }, { expiresIn: '5m' })
      return { requiresTwoFactor: true, challengeToken }
    }
    return finishLogin(app, reply, user)
  })

  app.post<{ Body: { challengeToken: string; code: string } }>('/2fa/verify', {
    config: { rateLimit: LOGIN_RATE_LIMIT },
  }, async (req, reply) => {
    let challenge: { purpose?: string; userId?: number }
    try { challenge = app.jwt.verify(req.body.challengeToken) }
    catch { return reply.code(401).send({ error: 'Two-factor challenge expired' }) }
    if (challenge.purpose !== 'two-factor-login' || !Number.isInteger(challenge.userId)) {
      return reply.code(401).send({ error: 'Invalid two-factor challenge' })
    }
    const user = (await db.select().from(users).where(eq(users.id, challenge.userId!)))[0]
    if (!user || !await verifySecondFactor(user, req.body.code)) {
      return reply.code(401).send({ error: 'Invalid authentication code' })
    }
    return finishLogin(app, reply, user)
  })

  app.get('/session', { preHandler: requireAuth }, async (req) => {
    return publicSession(req.user as AuthIdentity)
  })

  app.post('/logout', { preHandler: requireAuth }, async (req, reply) => {
    const identity = req.user as AuthIdentity
    await revokeSession(identity.sessionId)
    clearAuthCookies(reply)
    return reply.code(204).send()
  })

  app.post('/logout-all', { preHandler: requireAuth }, async (req, reply) => {
    const identity = req.user as AuthIdentity
    await revokeUserSessions(identity.userId)
    clearAuthCookies(reply)
    return reply.code(204).send()
  })

  app.post<{ Body: { newPassword: string; currentPassword?: string } }>('/change-password', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const { newPassword, currentPassword } = req.body
    if (!newPassword || newPassword.length < 8 || newPassword.length > 128) {
      return reply.code(400).send({ error: 'Password must be between 8 and 128 characters' })
    }
    const identity = req.user as AuthIdentity
    const user = (await db.select().from(users).where(eq(users.id, identity.userId)))[0]
    if (!user) return reply.code(404).send({ error: 'User not found' })

    if (!user.mustChangePassword) {
      if (!currentPassword) return reply.code(400).send({ error: 'Current password is required' })
      if (!await verifyPassword(user, currentPassword)) {
        return reply.code(400).send({ error: 'Current password is incorrect' })
      }
    }

    const passwordHash = await bcrypt.hash(newPassword, 10)
    await db.update(users).set({ passwordHash, mustChangePassword: 0 }).where(eq(users.id, user.id))
    await writeAudit(
      { userId: identity.userId, userEmail: identity.email },
      'update', 'user-security', identity.userId, identity.email,
      { passwordChanged: true },
    )
    await revokeUserSessions(user.id)
    const updated = { ...user, passwordHash, mustChangePassword: 0 }
    return finishLogin(app, reply, updated)
  })

  app.post<{ Body: { currentPassword: string } }>('/2fa/setup', { preHandler: requireAuth }, async (req, reply) => {
    const identity = req.user as AuthIdentity
    const user = (await db.select().from(users).where(eq(users.id, identity.userId)))[0]
    if (!user || !await verifyPassword(user, req.body.currentPassword)) {
      return reply.code(400).send({ error: 'Current password is incorrect' })
    }
    if (user.totpEnabled) return reply.code(409).send({ error: 'Two-factor authentication is already enabled' })
    const secret = generateTotpSecret()
    const uri = totpUri(secret, user.email)
    const setupToken = app.jwt.sign({
      purpose: 'two-factor-setup',
      userId: user.id,
      encryptedSecret: encrypt(secret),
    }, { expiresIn: '10m' })
    const qrDataUrl = await QRCode.toDataURL(uri, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
      color: { dark: '#111827', light: '#ffffff' },
    })
    return { secret, uri, qrDataUrl, setupToken }
  })

  app.post<{ Body: { setupToken: string; code: string } }>('/2fa/enable', { preHandler: requireAuth }, async (req, reply) => {
    const identity = req.user as AuthIdentity
    let setup: { purpose?: string; userId?: number; encryptedSecret?: string }
    try { setup = app.jwt.verify(req.body.setupToken) }
    catch { return reply.code(400).send({ error: 'Two-factor setup expired' }) }
    if (setup.purpose !== 'two-factor-setup' || setup.userId !== identity.userId || !setup.encryptedSecret) {
      return reply.code(400).send({ error: 'Invalid two-factor setup' })
    }
    const secret = decrypt(setup.encryptedSecret)
    if (!verifyTotp(secret, req.body.code)) {
      return reply.code(400).send({ error: 'Invalid authentication code' })
    }
    const recoveryCodes = generateRecoveryCodes()
    await db.update(users).set({
      totpSecret: encrypt(secret),
      totpEnabled: 1,
      totpRecoveryCodes: JSON.stringify(recoveryCodes.map(hashRecoveryCode)),
    }).where(eq(users.id, identity.userId))
    await revokeUserSessions(identity.userId, identity.sessionId)
    await writeAudit(
      { userId: identity.userId, userEmail: identity.email },
      'update', 'user-security', identity.userId, identity.email,
      { twoFactorEnabled: { from: false, to: true } },
    )
    return { recoveryCodes }
  })

  app.post<{ Body: { currentPassword: string; code: string } }>('/2fa/disable', { preHandler: requireAuth }, async (req, reply) => {
    const identity = req.user as AuthIdentity
    const user = (await db.select().from(users).where(eq(users.id, identity.userId)))[0]
    if (!user || !await verifyPassword(user, req.body.currentPassword)) {
      return reply.code(400).send({ error: 'Current password is incorrect' })
    }
    if (!user.totpEnabled) return reply.code(409).send({ error: 'Two-factor authentication is not enabled' })
    if (!await verifySecondFactor(user, req.body.code)) {
      return reply.code(400).send({ error: 'Invalid authentication code' })
    }
    await db.update(users).set({ totpSecret: null, totpEnabled: 0, totpRecoveryCodes: null }).where(eq(users.id, user.id))
    await revokeUserSessions(user.id, identity.sessionId)
    await writeAudit(
      { userId: identity.userId, userEmail: identity.email },
      'update', 'user-security', identity.userId, identity.email,
      { twoFactorEnabled: { from: true, to: false } },
    )
    return { twoFactorEnabled: false }
  })
}
