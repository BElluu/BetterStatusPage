import { customType } from 'drizzle-orm/sqlite-core'
import type { SecretBox } from './secretBox.js'

/** Marks a stored value as encrypted, so a column can hold rows from before it was sealed. */
export const SEALED_PREFIX = 'enc:v1:'

/** Turns a secret into what is stored and back. */
export interface Sealer {
  /**
   * Always encrypts, whatever the value looks like: a value that merely starts with the prefix is somebody's text, or a
   * ciphertext offered to be decrypted by the next read, and must never be taken for one already sealed. Empty stays empty.
   */
  seal(value: string): string
  /** Like `seal`, but leaves a value that is already sealed alone. Only for upgrading rows that may hold either. */
  sealPlain(value: string): string
  /** Opens a sealed value; a value without the prefix is a row from before sealing and is returned as it is. Throws when the key does not fit. */
  open(value: string): string
}

export function createSealer(box: Pick<SecretBox, 'encrypt' | 'decrypt'>): Sealer {
  const seal = (value: string) => (value === '' ? value : `${SEALED_PREFIX}${box.encrypt(value)}`)
  return {
    seal,
    sealPlain: (value) => (value.startsWith(SEALED_PREFIX) ? value : seal(value)),
    open: (value) => (value.startsWith(SEALED_PREFIX) ? box.decrypt(value.slice(SEALED_PREFIX.length)) : value),
  }
}

/** A text column whose value goes through `codec` on its way to and from the database; the rest of the code sees the open value. */
export function sealedText(codec: Pick<Sealer, 'seal' | 'open'>) {
  return customType<{ data: string; driverData: string }>({
    dataType: () => 'text',
    toDriver: codec.seal,
    fromDriver: codec.open,
  })
}

export type SealedText = ReturnType<typeof sealedText>
