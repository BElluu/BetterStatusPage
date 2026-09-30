import { writeAudit } from './audit.js'

/** How the user tried to sign in, as recorded in `diff.method` of 'sign_in' audit entries. */
export type SignInMethod = 'password' | 'sso'

/** Why a password, or the authentication-code step of any sign-in, was refused. SSO refusals use the OIDC codes. */
export type CredentialDenialCode =
  | 'password_login_disabled'
  | 'no_matching_account'
  | 'wrong_password'
  | 'two_factor_expired'
  | 'invalid_two_factor_code'

export interface SignInDenial {
  code: string
  reason: string
  email?: string | undefined
}

/** Records a successful sign-in; `twoFactor` says whether an authentication code was part of it. */
export async function auditSignIn(user: { id: number; email: string }, method: SignInMethod, twoFactor: boolean): Promise<void> {
  await writeAudit({ userId: user.id, userEmail: user.email }, 'allow', 'sign_in', user.id, user.email, { method, twoFactor })
}

/**
 * Records a refused sign-in. Nobody is signed in, so the actor is user 0 with the email that was entered or that
 * the provider asserted, when there was one. The user only ever sees a generic message; this holds the reason.
 */
export async function auditSignInDenial(method: SignInMethod, denial: SignInDenial, extra: Record<string, unknown> = {}): Promise<void> {
  await writeAudit(
    { userId: 0, userEmail: denial.email ?? `unknown (${method === 'sso' ? 'SSO' : 'password'})` },
    'deny', 'sign_in', null, denial.email ?? (method === 'sso' ? 'SSO sign-in' : 'Password sign-in'),
    { method, code: denial.code, reason: denial.reason, ...extra },
  )
}
