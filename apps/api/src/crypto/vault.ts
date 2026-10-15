import { vault } from '../kit/vault.js'

// Forwards to the secret box of the vault module; kept so call sites do not change.
export function encrypt(plaintext: string): string {
  return vault.secretBox.encrypt(plaintext)
}

export function decrypt(ciphertext: string): string {
  return vault.secretBox.decrypt(ciphertext)
}
