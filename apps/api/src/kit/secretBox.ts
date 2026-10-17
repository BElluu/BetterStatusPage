import { vault } from './vault.js'

// The secret box of this application's vault instance (./vault.ts).
export const { encrypt, decrypt } = vault.secretBox
