import type { UiConfig } from '@better-kit/ui'
import { statusPageUrl } from './navigation'

/** What the shared interface needs to know about this application. */
export const adminUiConfig: UiConfig = {
  storagePrefix: 'bsp',
  apiBase: '/api/v1',
  csrfCookie: 'bsp_csrf',
  basePath: '/admin',
  // A viewer may only view the status page, which also has them replace a temporary password.
  redirectAfterSignIn: (user) => user.role === 'viewer' ? statusPageUrl() : null,
}
