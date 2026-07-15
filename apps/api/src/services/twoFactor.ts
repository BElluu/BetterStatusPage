import { and, eq } from 'drizzle-orm'
import { consumeRecoveryCode, verifyTotp } from '../crypto/totp.js'
import { decrypt } from '../crypto/vault.js'
import { db } from '../db/client.js'
import { authSessions, users } from '../db/schema.js'
import { withImmediateTransaction } from '../db/transaction.js'

type TwoFactorUser = Pick<typeof users.$inferSelect, 'id' | 'totpEnabled' | 'totpSecret' | 'totpRecoveryCodes'>

/**
 * Verify a TOTP or consume a recovery code. Recovery-code persistence uses a
 * compare-and-swap update so the same code cannot win in concurrent requests.
 */
export async function verifySecondFactor(user: TwoFactorUser, code: string): Promise<boolean> {
  if (!user.totpEnabled || !user.totpSecret) return false
  if (verifyTotp(decrypt(user.totpSecret), code)) return true

  const storedCodes = user.totpRecoveryCodes
  const recovery = consumeRecoveryCode(storedCodes, code)
  if (!storedCodes || !recovery.valid) return false

  const updated = await db.update(users)
    .set({ totpRecoveryCodes: JSON.stringify(recovery.remaining) })
    .where(and(eq(users.id, user.id), eq(users.totpRecoveryCodes, storedCodes)))
    .returning({ id: users.id })
  return updated.length === 1
}

/** Clear 2FA credentials and revoke every active session for the user. */
export async function resetTwoFactor(userId: number): Promise<boolean> {
  return withImmediateTransaction(async () => {
    const updated = await db.update(users).set({
      totpSecret: null,
      totpEnabled: 0,
      totpRecoveryCodes: null,
    }).where(and(eq(users.id, userId), eq(users.totpEnabled, 1)))
      .returning({ id: users.id })
    if (updated.length !== 1) return false
    await db.delete(authSessions).where(eq(authSessions.userId, userId))
    return true
  })
}
