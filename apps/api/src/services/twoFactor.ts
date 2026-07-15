import { and, eq } from 'drizzle-orm'
import { consumeRecoveryCode, verifyTotp } from '../crypto/totp.js'
import { decrypt } from '../crypto/vault.js'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'

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
