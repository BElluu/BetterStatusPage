import { configureUi } from '../config'

/** The configuration the page tests run under: the admin console's, so their expectations read as the product's. */
export function configureForTests(): void {
  configureUi({
    storagePrefix: 'bsp',
    apiBase: '/api/v1',
    csrfCookie: 'bsp_csrf',
    basePath: '/admin',
    texts: {
      ssoNewAccount: 'Creates the Viewer account {user} for the private status page and links this identity-provider account to it.',
      ssoSignInHint: '',
    },
  })
}
