import { configureUi } from '../config'

/** The configuration the page tests run under: the admin console's, so their expectations read as the product's. */
export function configureForTests(): void {
  configureUi({
    storagePrefix: 'bsp',
    apiBase: '/api/v1',
    csrfCookie: 'bsp_csrf',
    basePath: '/admin',
    brand: { name: 'BetterStatusPage', logoLight: '/admin/logo_light.png', logoDark: '/admin/logo_dark.png' },
    texts: {
      ssoNewAccount: 'Creates the Viewer account {user} for the private status page and links this identity-provider account to it.',
      ssoSignInHint: '',
      appName: 'BetterStatusPage',
      tokenCannotManage: 'users, single sign-on, status page access, vaults, backups or other tokens',
      tokenVaultTargets: 'a monitor or channel',
      secretConsumers: 'monitors',
      vaultPathExample: 'bsp/database',
    },
  })
}
