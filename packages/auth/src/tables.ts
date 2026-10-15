import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  createdAt: integer('created_at').notNull(),
  // Additive columns (added via ALTER TABLE, must stay at end for sqlite-proxy position mapping)
  mustChangePassword: integer('must_change_password').notNull().default(0),
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled').notNull().default(0),
  totpRecoveryCodes: text('totp_recovery_codes'),
  // SSO identity bound on the first OIDC sign-in; later sign-ins match on it instead of the email.
  oidcIssuer: text('oidc_issuer'),
  oidcSubject: text('oidc_subject'),
})

export const authSessions = sqliteTable('auth_sessions', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  csrfTokenHash: text('csrf_token_hash').notNull(),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  // 'password' or 'oidc'. An SSO session never asks for the temporary password to be changed.
  authMethod: text('auth_method').notNull().default('password'),
  // When the user last proved who they are in this session: the sign-in, or a later SSO confirmation.
  verifiedAt: integer('verified_at'),
})

/** Long-lived bearer credentials for scripts and CI. Only the SHA-256 of the token is stored; revoking deletes the row. */
export const apiTokens = sqliteTable('api_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  /** Leading characters of the token, so it can be recognised in the list. */
  prefix: text('prefix').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at'),
  lastUsedAt: integer('last_used_at'),
  /** JSON list of what the token may do, e.g. `["notes:write","tags:read"]` (the permissions are defined by the application). */
  scopes: text('scopes').notNull(),
})

export const oidcSettings = sqliteTable('oidc_settings', {
  id: integer('id').primaryKey(),
  enabled: integer('enabled').notNull().default(0),
  issuer: text('issuer').notNull().default(''),
  clientId: text('client_id').notNull().default(''),
  /** Stored encrypted by the application's secret box; empty when no secret is set. */
  clientSecret: text('client_secret').notNull().default(''),
  scopes: text('scopes').notNull().default(''),
  redirectUri: text('redirect_uri').notNull().default(''),
  buttonLabel: text('button_label').notNull().default(''),
  allowUnverifiedEmail: integer('allow_unverified_email').notNull().default(0),
  disablePasswordLogin: integer('disable_password_login').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
})
