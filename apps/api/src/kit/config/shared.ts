import { clip, ENTITY_KEY_ERROR, isValidEntityKey } from '@better-forge/config-as-code'

/** How a document's `key` is checked. */
export const entityKeys = { isValid: isValidEntityKey, error: ENTITY_KEY_ERROR }

export const MAX_NAME_LENGTH = 200
export const MAX_CONFIG_DEPTH = 20

/** Export order within a kind. */
export const exportByKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

export const linkOrder = (a: { action: string; onStatus: string }, b: { action: string; onStatus: string }) =>
  (`${a.action}:${a.onStatus}` < `${b.action}:${b.onStatus}` ? -1 : 1)

/** The problem with a link to a key that does not exist after the import; `removed` holds the keys that prune deletes. */
export const missingLink = (what: string, key: string, removed: ReadonlySet<string>) =>
  removed.has(key)
    ? `${what} "${clip(key)}" is deleted by this import, because the file does not mention it: add it to the file or drop the link`
    : `unknown ${what} "${clip(key)}"`
