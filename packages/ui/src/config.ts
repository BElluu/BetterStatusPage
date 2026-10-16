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
}

let current: UiConfig = { storagePrefix: 'better', apiBase: '/api/v1', csrfCookie: 'better_csrf', basePath: '' }

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
