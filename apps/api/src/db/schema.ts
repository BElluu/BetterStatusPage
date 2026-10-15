// Every table of the application, by the module that owns it (see ./modules).
export * from './modules/auth/tables.js'
export { auditLog } from '@better-kit/audit'
export * from './modules/vault/tables.js'
export * from './modules/notify/tables.js'
export * from './modules/app/tables.js'
