import type { Json } from '@better-kit/config-as-code'
import { config, DOCUMENT_KINDS, type DocumentKind } from './config.js'

// Forwards to the configuration engine in ../kit/config.ts; kept so call sites do not change.
export { ConfigExportError } from '@better-kit/config-as-code'

/** A document of one of the kinds; the engine does not know their fields, the kinds do. */
export type ConfigDocument = Json & { kind: DocumentKind; key: string }

/**
 * The notification channels, actions and monitors as documents that do not depend on this installation's
 * numeric ids, in a fixed order: channels, actions, then monitors (each sorted by key). Secrets are masked
 * exactly as the API masks them, and runtime state (current status, last check, heartbeat token) is left out.
 */
export async function buildConfigDocuments(only?: { kind: DocumentKind; key: string }, options: { includeActions?: boolean } = {}): Promise<ConfigDocument[]> {
  const included = new Set<string>(DOCUMENT_KINDS.filter((kind) => kind !== 'Action' || (options.includeActions ?? true)))
  return await config.exportDocuments(only, { included }) as ConfigDocument[]
}

/** The one document of a kind and key, or undefined when there is none. */
export function pickDocument(documents: ConfigDocument[], kind: DocumentKind, key: string | undefined): ConfigDocument | undefined {
  return config.pickDocument(documents, kind, key) as ConfigDocument | undefined
}
