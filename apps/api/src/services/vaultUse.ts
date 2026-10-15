import { vaultUseGuard } from '../kit/vault.js'

export { canonical } from '@better-kit/vault'

export const VAULT_USE_REFUSED = vaultUseGuard.refused

export function vaultUseProblem(token: { scopes: readonly string[] } | undefined, incoming: unknown, stored: unknown): string | null {
  return vaultUseGuard.vaultUseProblem(token, incoming, stored)
}
