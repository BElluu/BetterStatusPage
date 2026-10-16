import { createConfigRoutes } from '@better-kit/config-as-code'
import { requestIdentity, requireRole } from './authMiddleware.js'
import { auditActor } from '../services/audit.js'
import { config } from './config.js'

/**
 * The configuration routes. A token needs `<resource>:read` or `:write` for each kind a file holds; a signed-in user needs
 * the role. Actions came after the other kinds: a full export leaves them out for a reader who may not see them.
 */
export const configRoutes = createConfigRoutes({
  engine: config,
  access: {
    Monitor: { tokenResource: 'monitors', roles: ['admin', 'operator'], roleLabel: 'operator' },
    NotificationChannel: { tokenResource: 'channels', roles: ['admin', 'operator'], roleLabel: 'operator' },
    Action: { tokenResource: 'actions', roles: ['admin'], roleLabel: 'admin', optional: true },
  },
  identity: requestIdentity,
  actor: (req) => auditActor(requestIdentity(req)),
  guards: [requireRole('operator')],
  // A monitor that carries an `actions` list links to actions, so importing it needs permission for them too.
  linkedKinds: (documents) => documents.some((document) => !!document && typeof document === 'object'
    && (document as { kind?: unknown }).kind === 'Monitor' && 'actions' in (document as object)) ? ['Action'] : [],
})
