import { createAppLock, createPublicUrlResolver, createSse, createUpdateCheck, dataDir } from '@better-kit/runtime'
import { getSseLimits } from '../config/sse.js'
import { resolveAppVersion } from '../version.js'

const NAME = 'BetterStatusPage'

/** The address the application is reached at (the PUBLIC_URL environment variable). */
export const resolvePublicUrl = createPublicUrlResolver()

/** Live event streams to the admin console and the status page. */
export const sse = createSse(getSseLimits())

/** Points out a newer release of this project on GitHub. */
export const updates = createUpdateCheck({ name: NAME, repository: 'BElluu/BetterStatusPage', version: () => resolveAppVersion() })

/** Marks the data directory as in use by a running instance. */
export const appLock = createAppLock({ name: NAME, fileName: '.bsp-running', dir: () => dataDir() })
