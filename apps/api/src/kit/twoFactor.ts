import type { Auth } from '@better-kit/auth'
import { auth } from './auth.js'

// Forwards to the instance in ../kit/auth.ts; kept so call sites do not change.
type Group = Auth['twoFactor']
export const verifySecondFactor: Group['verifySecondFactor'] = (...args: Parameters<Group['verifySecondFactor']>) => (auth.twoFactor.verifySecondFactor as (...a: unknown[]) => unknown)(...args) as never
export const resetTwoFactor: Group['resetTwoFactor'] = (...args: Parameters<Group['resetTwoFactor']>) => (auth.twoFactor.resetTwoFactor as (...a: unknown[]) => unknown)(...args) as never
