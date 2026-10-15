import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

export const vaults = sqliteTable('vaults', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull().default('local'), // 'local' | 'hashicorp'
  description: text('description'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /** Encrypted JSON connection settings of a 'hashicorp' vault; NULL for 'local'. Never sent to the browser. */
  connectionConfig: text('connection_config'),
})

export const vaultSecrets = sqliteTable('vault_secrets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vaultId: integer('vault_id').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'userpass' | 'value' | 'json'
  /** Local vault: the encrypted value. HashiCorp vault: the encrypted reference `{ path, key? }`. */
  encryptedValue: text('encrypted_value').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
