import type { Auth } from '@better-kit/auth'
import { auth } from '../kit/auth.js'

// Forwards to the instance in ../kit/auth.ts; kept so call sites do not change.
type Group = Auth['apiTokens']
export const parseScopes: Group['parseScopes'] = (...args: Parameters<Group['parseScopes']>) => (auth.apiTokens.parseScopes as (...a: unknown[]) => unknown)(...args) as never
export const isApiToken: Group['isApiToken'] = (...args: Parameters<Group['isApiToken']>) => (auth.apiTokens.isApiToken as (...a: unknown[]) => unknown)(...args) as never
export const hashApiToken: Group['hashApiToken'] = (...args: Parameters<Group['hashApiToken']>) => (auth.apiTokens.hashApiToken as (...a: unknown[]) => unknown)(...args) as never
export const generateApiToken: Group['generateApiToken'] = (...args: Parameters<Group['generateApiToken']>) => (auth.apiTokens.generateApiToken as (...a: unknown[]) => unknown)(...args) as never
export const findUsableApiToken: Group['findUsableApiToken'] = (...args: Parameters<Group['findUsableApiToken']>) => (auth.apiTokens.findUsableApiToken as (...a: unknown[]) => unknown)(...args) as never
export const consumeApiTokenBudget: Group['consumeApiTokenBudget'] = (...args: Parameters<Group['consumeApiTokenBudget']>) => (auth.apiTokens.consumeApiTokenBudget as (...a: unknown[]) => unknown)(...args) as never
export const resetApiTokenBudgets: Group['resetApiTokenBudgets'] = (...args: Parameters<Group['resetApiTokenBudgets']>) => (auth.apiTokens.resetApiTokenBudgets as (...a: unknown[]) => unknown)(...args) as never
