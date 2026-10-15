import { updates } from '../kit/runtime.js'

export { isNewerVersion, updateCheckEnabled, type LatestRelease } from '@better-kit/runtime'
export const { checkForUpdate, getAvailableUpdate, resetUpdateCheck, startUpdateCheck, stopUpdateCheck } = updates
