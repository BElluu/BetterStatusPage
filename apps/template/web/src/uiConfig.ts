import type { UiConfig } from '@better-forge/ui'

// A plain mark instead of a picture file, so the template needs no assets of its own.
const mark = (color: string) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="12" fill="${color}"/><circle cx="32" cy="32" r="28" fill="none" stroke="${color}" stroke-opacity=".35" stroke-width="3"/></svg>`,
)}`

/** What the shared interface needs to know about this application. */
export const uiConfig: UiConfig = {
  storagePrefix: 'tpl',
  apiBase: '/api/v1',
  csrfCookie: 'tpl_csrf',
  basePath: '',
  brand: { name: 'Better Template', logoLight: mark('#4b5563'), logoDark: mark('#d6d9df') },
  texts: {
    ssoNewAccount: 'Creates the account {user} and links this identity-provider account to it.',
    ssoSignInHint: '',
    appName: 'Better Template',
    secretConsumers: 'notification channels',
    vaultPathExample: 'template/database',
    tokenCannotManage: 'users, single sign-on, vaults, backups or other tokens',
    tokenVaultTargets: 'a notification channel',
  },
}
