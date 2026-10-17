import { vault } from './vault.js'

// The secret lookup of this application's vault instance (./vault.ts).
export const { loadSecretPayload, resolveVaultSecret } = vault.resolver
