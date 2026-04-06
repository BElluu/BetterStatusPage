import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

function getKey(): Buffer {
  const raw = process.env['VAULT_ENCRYPTION_KEY']
  if (!raw) {
    if (process.env['NODE_ENV'] === 'production') {
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

// Lazy-initialized key so the warning fires once at first use
let _key: Buffer | null = null
function key(): Buffer {
  if (!_key) _key = getKey()
  return _key
}

/** Encrypts plaintext with AES-256-GCM. Returns `iv:authTag:ciphertext` (all hex). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key(), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

/** Decrypts a value produced by `encrypt`. Throws on tampered data. */
export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(':')
  if (parts.length !== 3) throw new Error('Invalid ciphertext format')
  const [ivHex, tagHex, encHex] = parts as [string, string, string]
  const iv  = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const enc = Buffer.from(encHex, 'hex')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Invalid ciphertext length')
  const decipher = createDecipheriv(ALGORITHM, key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}
