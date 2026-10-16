import type { ImportResult } from '@better-kit/config-as-code'
import { config, DOCUMENT_KINDS, type DocumentKind } from '../kit/config.js'
import type { Actor } from './audit.js'

// Forwards to the configuration engine in ../kit/config.ts; kept so call sites do not change.
export { ConfigInvalidError } from '@better-kit/config-as-code'
export type { ImportResult }
export { DOCUMENT_KINDS, type DocumentKind }

export interface ImportOptions {
  dryRun: boolean
  actor: Actor
  /** Set when the request is made with an API token: what it may do decides if vault references may be used. */
  token?: { scopes: readonly string[] } | undefined
}

/** The kinds a list of documents contains, so that the caller can check it may import each. Documents of no known kind are ignored here. */
export const kindsIn = (documents: unknown[]) => config.kindsIn(documents) as Set<DocumentKind>

export const importConfig = (documents: unknown[], options: ImportOptions): Promise<ImportResult> => config.importDocuments(documents, options)
