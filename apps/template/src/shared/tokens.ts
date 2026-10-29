import { VAULT_USE_SCOPE, type TokenResource } from '@better-forge/contracts'

/** The parts of the API an API token can be given access to. The server checks tokens against them; the interface lists them. */
export const TOKEN_RESOURCES: readonly TokenResource[] = [
  { key: 'channels', label: 'Notification channels', description: 'Channels, SMTP settings and delivery history', levels: ['read', 'write'] },
  { key: 'audit', label: 'Audit log', description: 'Read the audit log', levels: ['read'] },
]

/** Permissions that belong to no part. */
export const EXTRA_SCOPES: readonly string[] = [VAULT_USE_SCOPE]
