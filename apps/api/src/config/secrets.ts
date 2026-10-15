const DEFAULT_JWT_SECRET = 'dev-secret-change-me'
export const JWT_EXPIRES_IN = '12h'
const EXAMPLE_SECRETS = new Set([
  'change-me-to-a-long-random-string',
  'change-me-to-a-64-char-hex-string',
])

export function resolveJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env['JWT_SECRET']
  if (env['NODE_ENV'] !== 'production') {
    if (!secret) console.warn('JWT_SECRET not set - using insecure default (development only)')
    return secret ?? DEFAULT_JWT_SECRET
  }
  if (!secret || secret.length < 32 || EXAMPLE_SECRETS.has(secret)) {
    throw new Error('JWT_SECRET must be set to a non-default value of at least 32 characters in production')
  }
  return secret
}

// The encryption key check lives in the vault module.
export { validateEncryptionKey as validateVaultEncryptionKey } from '@better-kit/vault'
