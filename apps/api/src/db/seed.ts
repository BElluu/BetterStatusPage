import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { db } from './client.js'
import { users, branding, layout } from './schema.js'
import { DEFAULT_BRANDING_COLORS } from '@bsp/shared'

const email = process.env['ADMIN_EMAIL']
const password = process.env['ADMIN_PASSWORD']

if (!email || !password || password.length < 8) {
  throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD (at least 8 characters) are required to seed an administrator')
}

const existingUsers = await db.select().from(users)
if (existingUsers.length === 0) {
  const hash = await bcrypt.hash(password, 10)
  await db.insert(users).values({
    email,
    passwordHash: hash,
    role: 'admin',
    createdAt: Date.now(),
  })
  console.log(`✓ Created admin user: ${email}`)
} else {
  console.log('  Admin user already exists, skipping')
}

const existingBranding = await db.select().from(branding)
if (existingBranding.length === 0) {
  await db.insert(branding).values({
    id: 1,
    siteName: 'My Status Page',
    primaryColor: DEFAULT_BRANDING_COLORS.primaryColor,
    accentColor: DEFAULT_BRANDING_COLORS.accentColor,
    updatedAt: Date.now(),
  })
  console.log('✓ Created default branding')
}

const existingLayout = await db.select().from(layout)
if (existingLayout.length === 0) {
  const defaultTree = JSON.stringify({ id: 'root', type: 'page', children: [] })
  await db.insert(layout).values({ id: 1, tree: defaultTree, updatedAt: Date.now() })
  console.log('✓ Created default layout')
}

console.log('✓ Seed complete')
