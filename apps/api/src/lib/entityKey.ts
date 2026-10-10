import { randomBytes } from 'node:crypto'

/** Keys appear in config files and URLs: lowercase, digits, `-` and `_`, starting with a letter or digit. */
export const ENTITY_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const ENTITY_KEY_ERROR = 'Key must be 1-64 characters: lowercase letters, digits, "-" or "_", starting with a letter or digit'

/** Fallback for rows inserted without a key (the routes derive one from the name instead). */
export function randomEntityKey(): string {
  return `k-${randomBytes(5).toString('hex')}`
}

export function isValidEntityKey(value: unknown): value is string {
  return typeof value === 'string' && ENTITY_KEY_PATTERN.test(value)
}

export function slugifyKey(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[łŁ]/g, 'l') // does not decompose into l + diacritic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return slug || 'item'
}

/** Resolves the id of the row holding `key`, if any. */
export type KeyOwner = (key: string) => Promise<number | undefined>

export type KeyResult = { key: string } | { status: 400 | 409; error: string }

/** Key for a new row: the requested one when given (validated, must be free), else the first free slug of `name`. */
export async function keyForNew(name: string, requested: unknown, ownerOf: KeyOwner): Promise<KeyResult> {
  if (requested !== undefined) {
    if (!isValidEntityKey(requested)) return { status: 400, error: ENTITY_KEY_ERROR }
    return (await ownerOf(requested)) === undefined ? { key: requested } : { status: 409, error: `Key "${requested}" is already in use` }
  }
  const base = slugifyKey(name)
  let candidate = base
  for (let n = 2; (await ownerOf(candidate)) !== undefined; n++) candidate = `${base}-${n}`
  return { key: candidate }
}
