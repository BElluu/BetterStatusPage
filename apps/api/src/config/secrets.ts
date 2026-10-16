// The session secret lives in the runtime package, the encryption key check in the vault module; kept so call sites do not change.
export { JWT_EXPIRES_IN, resolveJwtSecret } from '@better-kit/runtime'
export { validateEncryptionKey as validateVaultEncryptionKey } from '@better-kit/vault'
