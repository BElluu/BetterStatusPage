/** Full-page navigation, kept in one object so tests can observe it (jsdom cannot navigate). */
export const navigation = {
  assign(url: string): void {
    window.location.assign(url)
  },
}

/** The status page: on this origin in production, on its own dev server (:5174) in development. */
export function statusPageUrl(): string {
  return window.location.port === '5173' ? `${window.location.protocol}//${window.location.hostname}:5174/` : '/'
}
