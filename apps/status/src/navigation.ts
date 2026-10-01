/** Full-page navigation, kept in one object so tests can observe it (jsdom cannot navigate). */
export const navigation = {
  assign(url: string): void {
    window.location.assign(url)
  },
}

/** A page of the admin console: on this origin in production, on its own dev server (:5173) in development. */
export function adminUrl(path: string): string {
  const base = window.location.port === '5174' ? `${window.location.protocol}//${window.location.hostname}:5173` : ''
  return `${base}/admin${path}`
}
