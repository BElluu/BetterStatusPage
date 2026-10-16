import { ENTITY_KEY_ERROR, isValidEntityKey } from '@better-kit/config-as-code'

/** How a document's `key` is checked. */
export const entityKeys = { isValid: isValidEntityKey, error: ENTITY_KEY_ERROR }

export const MAX_NAME_LENGTH = 200
export const MAX_CONFIG_DEPTH = 20

/** Export order within a kind. */
export const exportByKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

export const linkOrder = (a: { action: string; onStatus: string }, b: { action: string; onStatus: string }) =>
  (`${a.action}:${a.onStatus}` < `${b.action}:${b.onStatus}` ? -1 : 1)
