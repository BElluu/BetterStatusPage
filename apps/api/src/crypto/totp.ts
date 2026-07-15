import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const PERIOD_SECONDS = 30
const DIGITS = 6

function encodeBase32(input: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of input) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31]
  return output
}

function decodeBase32(input: string): Buffer {
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const character of input.toUpperCase().replace(/=|\s|-/g, '')) {
    const index = ALPHABET.indexOf(character)
    if (index < 0) throw new Error('Invalid base32 secret')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

function codeAt(secret: string, counter: number): string {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', decodeBase32(secret)).update(buffer).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff)
  return String(binary % (10 ** DIGITS)).padStart(DIGITS, '0')
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20))
}

export function verifyTotp(secret: string, input: string, now = Date.now()): boolean {
  const normalized = input.replace(/\s/g, '')
  const counter = Math.floor(now / 1000 / PERIOD_SECONDS)
  return [-1, 0, 1].some((offset) => safeEqual(codeAt(secret, counter + offset), normalized))
}

export function generateTotpCode(secret: string, now = Date.now()): string {
  return codeAt(secret, Math.floor(now / 1000 / PERIOD_SECONDS))
}

export function totpUri(secret: string, email: string): string {
  const issuer = 'BetterStatusPage'
  const label = `${issuer}:${email}`
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD_SECONDS}`
}

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: 8 }, () => {
    const value = randomBytes(10).toString('hex').toUpperCase()
    return value.match(/.{1,5}/g)!.join('-')
  })
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.replace(/\s|-/g, '').toUpperCase()).digest('hex')
}

export function consumeRecoveryCode(storedJson: string | null, input: string): { valid: boolean; remaining: string[] } {
  let stored: string[]
  try { stored = JSON.parse(storedJson ?? '[]') as string[] } catch { return { valid: false, remaining: [] } }
  const candidate = hashRecoveryCode(input)
  const index = stored.findIndex((hash) => safeEqual(hash, candidate))
  if (index < 0) return { valid: false, remaining: stored }
  return { valid: true, remaining: stored.filter((_, itemIndex) => itemIndex !== index) }
}
