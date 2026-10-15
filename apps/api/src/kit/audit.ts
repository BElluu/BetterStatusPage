import { createAudit } from '@better-kit/audit'
import { db } from '../db/client.js'

/** The audit log of this application. The database handle is the lazy one, so it may be opened after this module loads. */
export const audit = createAudit({ db })
