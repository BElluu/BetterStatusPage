import { totpUri as authenticatorUri } from '@better-kit/auth'

// The authenticator-code functions live in the auth package; kept so call sites do not change.
export { consumeRecoveryCode, generateRecoveryCodes, generateTotpCode, generateTotpSecret, hashRecoveryCode, verifyTotp } from '@better-kit/auth'

export function totpUri(secret: string, email: string): string {
  return authenticatorUri(secret, email, 'BetterStatusPage')
}
