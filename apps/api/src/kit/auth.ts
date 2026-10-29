import { createAuth, createTokenCatalogue, type Auth } from '@better-forge/auth'
import { VAULT_USE_SCOPE } from '@better-forge/contracts'
import { TOKEN_PRESETS, TOKEN_RESOURCES } from '@bsp/shared'
import { db, sqlite } from '../db/client.js'
import { vault } from './vault.js'
import { resolvePublicUrl } from './runtime.js'
import { LOGIN_RATE_LIMIT, SENSITIVE_ACTION_RATE_LIMIT } from '../config/rateLimits.js'
import { getStatusPageAccess, viewerProvisioningAllowed } from '../services/statusPageAccess.js'
import { sseService } from './sse.js'
import { audit } from './audit.js'
import { roles } from './roles.js'

/** What an API token may be given access to: the parts of this application's admin API, and the permission to use vault secrets. */
export const tokenCatalogue = createTokenCatalogue({
  resources: TOKEN_RESOURCES,
  extraScopes: [VAULT_USE_SCOPE],
  presets: () => TOKEN_PRESETS,
})

/**
 * Accounts, sessions, SSO and API tokens of this application. The `db` and `sqlite` handles are the lazy ones, so the
 * database may be opened after this module loads (the setup wizard does that).
 */
export const auth: Auth = createAuth({
  db,
  sqlite,
  audit,
  roles,
  tokens: tokenCatalogue,
  secretBox: vault.secretBox,
  cookies: { session: 'bsp_session', csrf: 'bsp_csrf', oidcFlow: 'bsp_oidc_flow', twoFactorChallenge: 'bsp_2fa_challenge' },
  apiTokenPrefix: 'bsp_',
  totpIssuer: 'BetterStatusPage',
  basePath: '/api/v1/auth',
  urls: { signIn: '/admin/login', home: '/admin/', ssoConfirm: '/admin/sso-confirm', ssoTest: '/admin/sso-test' },
  publicUrl: resolvePublicUrl,
  secureCookies: () => process.env['NODE_ENV'] === 'production',
  rateLimits: { signIn: LOGIN_RATE_LIMIT, sensitiveAction: SENSITIVE_ACTION_RATE_LIMIT },
  returnTargets: ['status'],
  hooks: {
    // Ending a session also closes the live event streams it had open.
    onSessionsRevoked(match) {
      if ('sessionId' in match) sseService.disconnectSessions((session) => session.sessionId === match.sessionId)
      else sseService.disconnectSessions((session) => session.userId === match.userId && session.sessionId !== match.exceptSessionId)
    },
    // A first SSO sign-in to a private status page may create a viewer account, when the page's access settings allow it.
    async resolveUnknownSsoUser({ email }) {
      return viewerProvisioningAllowed(await getStatusPageAccess(), email) ? { role: 'viewer' } : null
    },
    // A viewer has nothing to do in the admin console, so they land on the status page wherever they started; sign-in
    // errors are shown on the screen the sign-in started from.
    signInRedirect(flow, outcome) {
      // PUBLIC_URL, because the callback may run on another origin than the status page (the admin dev server).
      const statusPage = `${resolvePublicUrl()}/`
      const fromStatusPage = flow.returnTo === 'status'
      if (outcome === 'two-factor') return fromStatusPage ? `${statusPage}?two-factor=sso` : undefined
      if ('error' in outcome) return fromStatusPage ? `${statusPage}?sign-in-error=${outcome.error}` : undefined
      return fromStatusPage || outcome.role === 'viewer' ? statusPage : undefined
    },
  },
})
