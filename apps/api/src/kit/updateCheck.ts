import { updates } from './runtime.js'

export { isNewerVersion, updateCheckEnabled, type LatestRelease } from '@better-forge/runtime'
export const { checkForUpdate, getAvailableUpdate, resetUpdateCheck, startUpdateCheck, stopUpdateCheck } = updates
