import type { TranslationKey } from '../types/locale.js'
import { EN_DEFAULTS } from './en.js'
import { PL_DEFAULTS } from './pl.js'

export { EN_DEFAULTS, PL_DEFAULTS }

export type TranslationDictionary = Record<TranslationKey, string>

/** Languages that ship with complete copy, keyed by locale code. */
export const BUILT_IN_DEFAULTS: Readonly<Record<string, { language: string; translations: TranslationDictionary }>> = {
  en: { language: 'English', translations: EN_DEFAULTS },
  pl: { language: 'Polish', translations: PL_DEFAULTS },
}

/** The built-in dictionary for a locale code ("pl", "pl-PL"), or null when the language has none. */
export function builtInDefaultsFor(code: string): { language: string; translations: TranslationDictionary } | null {
  const base = code.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return Object.hasOwn(BUILT_IN_DEFAULTS, base) ? BUILT_IN_DEFAULTS[base]! : null
}

/**
 * Resolves one key: the locale's own value, then its built-in language defaults, then English.
 * Empty strings count as "not translated", since the editor saves cleared fields that way.
 */
export function resolveTranslation(
  code: string,
  translations: Partial<Record<TranslationKey, string>>,
  key: TranslationKey,
): string {
  return translations[key] || builtInDefaultsFor(code)?.translations[key] || EN_DEFAULTS[key] || key
}
