import type { UiConfig } from '@better-forge/ui'
import { statusPageUrl } from './navigation'

/** What the shared interface needs to know about this application. */
export const adminUiConfig: UiConfig = {
  storagePrefix: 'bsp',
  apiBase: '/api/v1',
  csrfCookie: 'bsp_csrf',
  basePath: '/admin',
  // A viewer may only view the status page, which also has them replace a temporary password.
  redirectAfterSignIn: (user) => user.role === 'viewer' ? statusPageUrl() : null,
  brand: { name: 'BetterStatusPage', logoLight: '/admin/logo_light.png', logoDark: '/admin/logo_dark.png' },
  texts: {
    ssoNewAccount: 'Creates the Viewer account {user} for the private status page and links this identity-provider account to it.',
    ssoSignInHint: 'Who gets an account on a first sign-in is set in the sections on the right.',
    appName: 'BetterStatusPage',
    tokenCannotManage: 'users, single sign-on, status page access, vaults, backups or other tokens',
    tokenVaultTargets: 'a monitor or channel',
    secretConsumers: 'monitors',
    vaultPathExample: 'bsp/database',
  },
}
