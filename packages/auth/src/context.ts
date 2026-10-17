import type { DatabaseSync } from 'node:sqlite'
// Loaded for the request and reply properties they add (`cookies`, `jwt`, `user`, route `rateLimit` config).
import type {} from '@fastify/cookie'
import type {} from '@fastify/jwt'
import type {} from '@fastify/rate-limit'
import type { Audit } from '@better-kit/audit'
import type { SqliteDatabase } from '@better-kit/db'
import type { RoleRegistry } from './roles.js'
import type { TokenCatalogue } from './tokenCatalogue.js'

/** Which sessions were ended, so the application can close what they had open (for example live connections). */
export type SessionsRevoked =
  | { sessionId: string }
  | { userId: number; exceptSessionId?: string | undefined }

export interface UnknownSsoUser {
  email: string
  subject: string
  issuer: string
}

export type SignInOutcome = { role: string } | { error: string } | 'two-factor'

export interface AuthHooks {
  /** Called after sessions were deleted, whatever the reason (sign-out, password reset, role change, ...). */
  onSessionsRevoked?: (match: SessionsRevoked) => void
  /**
   * An SSO sign-in succeeded at the provider but no account matches. Return the role of an account to create for
   * this person, or null to refuse. Only called when the provider's identity is verified; without this hook nobody
   * is created.
   */
  resolveUnknownSsoUser?: (user: UnknownSsoUser) => Promise<{ role: string } | null>
  /**
   * Where a sign-in goes next, for one that started with a `returnTo` target the application listed in
   * `returnTargets`, or for a role that belongs somewhere else than `urls.home`. Return undefined for the default.
   */
  signInRedirect?: (flow: { returnTo?: string | undefined }, outcome: SignInOutcome) => string | undefined
}

/** A `@fastify/rate-limit` route configuration. Passed through untouched, so a group id can be shared with other routes. */
export interface RateLimitConfig {
  groupId?: string
  max: number
  timeWindow: string | number
}

/**
 * Everything the auth module needs from the application. All of it is passed in: the module reads no globals, so
 * two applications (or two tests) can each have their own.
 */
export interface AuthOptions {
  /** Database handle and the raw connection (for transactions). Both are used lazily, so they may be opened after this is created. */
  db: SqliteDatabase
  sqlite: DatabaseSync
  audit: Pick<Audit, 'write' | 'actor' | 'diffObjects' | 'snapshot'>
  roles: RoleRegistry
  tokens: TokenCatalogue
  /** Encrypts and decrypts secrets the module stores (the SSO client secret, authenticator secrets). */
  secretBox: { encrypt(plain: string): string; decrypt(stored: string): string }
  cookies: { session: string; csrf: string; oidcFlow: string; twoFactorChallenge: string }
  /** Prefix that tells an API token from a session token in a Bearer header. */
  apiTokenPrefix: string
  /** Name an authenticator app shows next to the account. */
  totpIssuer: string
  /** Where the sign-in routes are mounted. The cookie paths and the SSO callback derive from it. */
  basePath: string
  urls: {
    /** Where a failed sign-in sends the browser, e.g. `/admin/login`. */
    signIn: string
    /** Where a finished sign-in goes by default. */
    home: string
    /** The page that closes the SSO confirmation popup. */
    ssoConfirm: string
    /** The page that shows the result of an SSO test. */
    ssoTest: string
  }
  /** The address the application is reached at, from the environment; '' when unknown. */
  publicUrl: (env: NodeJS.ProcessEnv) => string
  /** Whether cookies are marked Secure. Evaluated on every response. */
  secureCookies: () => boolean
  rateLimits: { signIn: RateLimitConfig; sensitiveAction: RateLimitConfig }
  /** `returnTo` values a sign-in may start with; the application's `signInRedirect` hook turns them into a destination. */
  returnTargets?: readonly string[]
  hooks?: AuthHooks
}
