import { vault } from '../kit/vault.js'

// Forwards to the secret lookup of the vault module; kept so call sites do not change.
export const loadSecretPayload: typeof vault.resolver.loadSecretPayload = (...args) => vault.resolver.loadSecretPayload(...args)
export const resolveVaultSecret: typeof vault.resolver.resolveVaultSecret = (...args) => vault.resolver.resolveVaultSecret(...args)
