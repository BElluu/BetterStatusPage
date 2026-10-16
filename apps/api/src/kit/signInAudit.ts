import type { Auth } from '@better-kit/auth'
import { auth } from './auth.js'
export type { CredentialDenialCode, SignInDenial, SignInMethod } from '@better-kit/auth'

// Forwards to the instance in ../kit/auth.ts; kept so call sites do not change.
type Group = Auth['signInAudit']
export const auditSignIn: Group['auditSignIn'] = (...args: Parameters<Group['auditSignIn']>) => (auth.signInAudit.auditSignIn as (...a: unknown[]) => unknown)(...args) as never
export const auditSignInDenial: Group['auditSignInDenial'] = (...args: Parameters<Group['auditSignInDenial']>) => (auth.signInAudit.auditSignInDenial as (...a: unknown[]) => unknown)(...args) as never
