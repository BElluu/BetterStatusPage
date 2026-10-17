import type { AuthOptions } from './context.js'
import { createApiTokenRoutes } from './apiTokenRoutes.js'
import { createApiTokens } from './apiTokens.js'
import { createIdentityConfirmation } from './identityConfirmation.js'
import { createMiddleware } from './middleware.js'
import { createOidc } from './oidc.js'
import { createOidcConfigResolver } from './oidcConfig.js'
import { createOidcSettings } from './oidcSettings.js'
import { createOidcSettingsRoutes } from './oidcSettingsRoutes.js'
import { createSessions } from './sessions.js'
import { createSignInAudit } from './signInAudit.js'
import { createSignInRoutes } from './authRoutes.js'
import { createTwoFactor } from './twoFactor.js'
import { createUserRoutes } from './userRoutes.js'

/**
 * Accounts, sessions, two-factor sign-in, single sign-on, API tokens and the routes that manage them. Everything is
 * built from `options` and kept in the returned closures; nothing is shared between two calls.
 */
export function createAuth(options: AuthOptions) {
  options.roles.freeze()

  const apiTokens = createApiTokens(options)
  const sessions = createSessions(options, apiTokens)
  const middleware = createMiddleware(sessions, apiTokens)
  const identityConfirmation = createIdentityConfirmation(options)
  const twoFactor = createTwoFactor(options)
  const signInAudit = createSignInAudit(options)
  const oidcConfig = createOidcConfigResolver({ publicUrl: options.publicUrl, callbackPath: `${options.basePath}/oidc/callback` })
  const oidcSettings = createOidcSettings(options, oidcConfig)
  const oidc = createOidc(options, signInAudit)

  const signIn = createSignInRoutes(options, { sessions, middleware, twoFactor, identityConfirmation, signInAudit, oidcSettings, oidc })
  const users = createUserRoutes(options, { sessions, twoFactor, identityConfirmation })
  const oidcSettingsRoutes = createOidcSettingsRoutes(options, { identityConfirmation, oidc, oidcSettings, resolver: oidcConfig, startOidcFlow: signIn.startOidcFlow })
  const tokenRoutes = createApiTokenRoutes(options, apiTokens)

  return {
    sessions,
    middleware,
    identityConfirmation,
    twoFactor,
    signInAudit,
    oidcConfig,
    oidcSettings,
    oidc,
    apiTokens,
    /** Plain plugins (not wrapped for encapsulation), so the hooks of the scope they are registered in apply to them. */
    routes: {
      signIn: signIn.authRoutes,
      users: users.userRoutes,
      oidcSettings: oidcSettingsRoutes.oidcSettingsRoutes,
      apiTokens: tokenRoutes.apiTokenRoutes,
    },
  }
}

export type Auth = ReturnType<typeof createAuth>
