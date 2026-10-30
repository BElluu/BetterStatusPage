export { navigation } from '@better-forge/ui'

/** The status page: on this origin in production, on its own dev server (:5174) in development. */
export function statusPageUrl(): string {
  return window.location.port === '5173' ? `${window.location.protocol}//${window.location.hostname}:5174/` : '/'
}

export const DOCS_URL = 'https://docs.betterstatuspage.dev'
