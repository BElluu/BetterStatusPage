export interface UiConfig {
  /** Names what the interface keeps in the browser: keys in storage and window events start with it (`<prefix>-dark-mode`). */
  storagePrefix: string
  /** Where the API answers. */
  apiBase: string
  /** The cookie the server puts the CSRF token in; it is sent back in a header on every change. */
  csrfCookie: string
  /** Where the interface is served, without a trailing slash (`/admin`): the pages to sign in and to change a password are below it. */
  basePath: string
  /** For a user who does not belong in this interface (say, one who may only view a public page): the address to send them to instead. */
  redirectAfterSignIn?: (user: { role: string }) => string | null
  /** Wording that names things only the application knows. */
  texts: {
    /** Said when a test sign-in would create an account; `{user}` is replaced by the account. */
    ssoNewAccount: string
    /** Added to the single sign-on settings to say who may sign in; empty adds nothing. */
    ssoSignInHint: string
    /** The name of the application, as the interface calls it in sentences. */
    appName: string
    /** What uses the secrets kept in a vault (`monitors`), in sentences like "... that monitors can use". */
    secretConsumers: string
    /** An example of the path of a secret in an external vault. */
    vaultPathExample: string
  }
}

let current: UiConfig = { storagePrefix: 'better', apiBase: '/api/v1', csrfCookie: 'better_csrf', basePath: '', texts: { ssoNewAccount: 'Creates the account {user} and links this identity-provider account to it.', ssoSignInHint: '', appName: 'This application', secretConsumers: 'the application', vaultPathExample: 'app/database' } }

/**
 * Tells the interface what application it is part of. Call it before anything is rendered; what is read from storage
 * is read on first use, after this.
 */
export function configureUi(options: Partial<UiConfig>): void {
  current = { ...current, ...options }
}

export const uiConfig = (): UiConfig => current

/** The name the interface uses for `name` in storage and in window events. */
export const storageKey = (name: string): string => `${current.storagePrefix}-${name}`
