import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { db, closeDb, initDb } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { users } from '../db/schema.js'
import { writeAudit } from '../services/audit.js'
import { resetTwoFactor } from '../services/twoFactor.js'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const email = argument('--email')
  const confirmation = argument('--confirm')
  if (!email || confirmation !== email) {
    throw new Error('Usage: 2fa:reset -- --email <user@example.com> --confirm <user@example.com>')
  }

  initDb()
  try {
    runMigrations()
    const user = (await db.select().from(users).where(eq(users.email, email)))[0]
    if (!user) throw new Error(`User not found: ${email}`)
    if (!user.totpEnabled) throw new Error(`Two-factor authentication is not enabled for: ${email}`)
    if (!await resetTwoFactor(user.id)) throw new Error(`Two-factor authentication is already disabled for: ${email}`)
    await writeAudit(
      { userId: user.id, userEmail: 'system:cli' },
      'update', 'user-security', user.id, user.email,
      { twoFactorReset: { from: true, to: false }, method: 'emergency_cli' },
    )
    console.log(`Two-factor authentication reset for ${email}. All active sessions were revoked.`)
  } finally {
    closeDb()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
