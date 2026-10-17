import { appLock } from './runtime.js'

export const { assertAppStopped, acquireAppLock } = appLock
