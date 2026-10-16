let prefix = 'better'

/**
 * Names the application for what the interface keeps in the browser: its keys in local storage and its events start
 * with this prefix (`<prefix>-dark-mode`, `<prefix>-date-format`, `<prefix>-auth-user`). Call it before anything is
 * rendered; what is read from storage is read on first use, after this.
 */
export function configureUi(options: { storagePrefix: string }): void {
  prefix = options.storagePrefix
}

/** The name the interface uses for `name` in storage and in window events. */
export const storageKey = (name: string): string => `${prefix}-${name}`
