import { appLock } from '../kit/runtime.js'

export const { assertAppStopped, acquireAppLock } = appLock
