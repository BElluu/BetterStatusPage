import { configureUi } from '../config'

/** The configuration the page tests run under. */
export function configureForTests(): void {
  configureUi({
    storagePrefix: 'test',
    apiBase: '/api/v1',
    csrfCookie: 'test_csrf',
    basePath: '/admin',
    brand: { name: 'Test App', logoLight: '/admin/logo_light.png', logoDark: '/admin/logo_dark.png' },
    texts: {
      ssoNewAccount: 'Creates the Viewer account {user} and links this identity-provider account to it.',
      ssoSignInHint: '',
      appName: 'Test App',
      tokenCannotManage: 'users, single sign-on, vaults or other tokens',
      tokenVaultTargets: 'an object',
      secretConsumers: 'the application',
      vaultPathExample: 'app/database',
    },
  })
}
