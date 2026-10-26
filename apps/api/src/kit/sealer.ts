import { createSealer, createSecretBox } from '@better-kit/vault'

/**
 * The secret box of this application and the sealer built on it. They live apart from ./vault.ts because the tables
 * seal their own columns with them, and ./vault.ts needs the database that those tables describe.
 */
export const secretBox = createSecretBox()
export const sealer = createSealer(secretBox)
