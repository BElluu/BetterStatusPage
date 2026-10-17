import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

export interface SecretBox {
  /** Encrypts plaintext with AES-256-GCM. Returns `iv:authTag:ciphertext` (all hex). */
  encrypt(plaintext: string): string
  /** Decrypts a value produced by `encrypt`. Throws on tampered data. */
  decrypt(ciphertext: string): string
}

/**
 * Encryption of the secrets an application stores, with the key from `VAULT_ENCRYPTION_KEY` (64 hex characters).
 * The key is read on first use, so the warning about the development fallback appears once per box.
 * `env` is read at that moment, not captured, so a test may change it before first use.
 */
export function createSecretBox(options: { env?: NodeJS.ProcessEnv } = {}): SecretBox {
  const env = options.env ?? process.env
  let cachedKey: Buffer | null = null

  function getKey(): Buffer {
    const raw = env['VAULT_ENCRYPTION_KEY']
    if (!raw) {
      if (env['NODE_ENV'] === 'production') {
        throw new Error('VAULT_ENCRYPTION_KEY environment variable must be set in production')
      }
      // Dev fallback — 32-byte zero key with warning
      console.warn('⚠ VAULT_ENCRYPTION_KEY not set — using insecure dev key (development only)')
      return Buffer.alloc(32, 0)
    }
    const buf = Buffer.from(raw, 'hex')
    if (buf.length !== 32) {
      throw new Error('VAULT_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)')
    }
    return buf
  }

  const key = () => (cachedKey ??= getKey())

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGORITHM, key(), iv)
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
    },
    decrypt(ciphertext) {
      const parts = ciphertext.split(':')
      if (parts.length !== 3) throw new Error('Invalid ciphertext format')
      const [ivHex, tagHex, encHex] = parts as [string, string, string]
      const iv = Buffer.from(ivHex, 'hex')
      const tag = Buffer.from(tagHex, 'hex')
      const enc = Buffer.from(encHex, 'hex')
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Invalid ciphertext length')
      const decipher = createDecipheriv(ALGORITHM, key(), iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
    },
  }
}

/** In production the key must be exactly 64 hexadecimal characters; refuses to start otherwise. Elsewhere anything goes. */
export function validateEncryptionKey(env: NodeJS.ProcessEnv = process.env): void {
  if (env['NODE_ENV'] !== 'production') return
  const key = env['VAULT_ENCRYPTION_KEY']
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('VAULT_ENCRYPTION_KEY must be set to exactly 64 hexadecimal characters in production')
  }
}
