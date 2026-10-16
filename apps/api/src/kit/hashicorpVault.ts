import { vault } from './vault.js'

export { HashicorpVaultError, hashicorpLimits } from '@better-kit/vault'
export type { CredentialsRef, HashicorpAuthMethod, HashicorpConfig, HashicorpVaultRow } from '@better-kit/vault'

// Forwards to the HashiCorp client of the vault module; kept so call sites do not change.
export const forgetHashicorpVault: typeof vault.hashicorp.forgetHashicorpVault = (...args) => vault.hashicorp.forgetHashicorpVault(...args)
export const readKvSecret: typeof vault.hashicorp.readKvSecret = (...args) => vault.hashicorp.readKvSecret(...args)
