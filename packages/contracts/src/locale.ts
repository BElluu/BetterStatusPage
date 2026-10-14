export interface Locale<Key extends string = string> {
  code: string
  name: string
  isDefault: number
  translations: Partial<Record<Key, string>>
  updatedAt: number
}

export interface LocaleSummary {
  code: string
  name: string
  isDefault?: number
}

/** The language part of a locale code: "pl-PL" and "pl_PL" are both "pl". */
export function baseLanguage(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0] ?? ''
}
