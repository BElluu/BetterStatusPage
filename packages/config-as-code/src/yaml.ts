import { Document, parseAllDocuments, visit } from 'yaml'

/** Anchors are legitimate in a hand-written file, but a few are plenty and unbounded aliases are a decompression bomb. */
const MAX_YAML_ALIASES = 20
/** Documents one file may hold. */
export const MAX_DOCUMENTS = 2_000
/** Longest part of a parser error that is repeated to the caller. */
const MAX_ERROR_LENGTH = 300

/**
 * Strings the library leaves bare although a parser reads them as something else: `<<` is the YAML 1.1 merge key (as a
 * key it merges, or fails), and `0o17` is a number in YAML 1.2 but a string in 1.1.
 */
const NEEDS_QUOTES = /^(<<|=|0o[0-7]+)$/

/**
 * No line folding: URLs and templates must stay on one line to be readable and diff well. Version 1.1 makes the
 * writer quote what an older parser would misread ("22:00" is a number there, "yes" and "on" are booleans), so the
 * file means the same to every YAML tool, Terraform's included.
 */
export function toYaml(value: unknown): string {
  const document = new Document(value, { version: '1.1' })
  visit(document, {
    Scalar(position, node) {
      if (typeof node.value !== 'string' || !NEEDS_QUOTES.test(node.value)) return
      node.type = 'QUOTE_DOUBLE'
      // The 1.1 schema recognises the string `<<` as the merge key and would write it bare whatever the style; as a
      // key it needs an explicit string tag. As a value it is plain text and quoting is enough.
      if (position === 'key' && node.value === '<<') node.tag = 'tag:yaml.org,2002:str'
    },
  })
  return document.toString({ lineWidth: 0 })
}

/** Several documents in one YAML file, separated the usual way. */
export const toYamlStream = (documents: unknown[]): string => documents.map(toYaml).join('---\n')

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}…` : value

/**
 * The documents of a YAML text, in the order they are written (empty ones left out), or the reason it was refused.
 * The text is parsed with the YAML 1.2 core schema; a `%YAML` line would switch to rules under which `yes` is a
 * boolean and `22:00` a number, so it is refused.
 */
export function readDocuments(body: unknown): { documents: unknown[] } | { error: string } {
  if (typeof body !== 'string') return { error: 'Send the documents as YAML' }
  if (/^%YAML/m.test(body)) return { error: 'Invalid YAML: %YAML directives are not supported' }
  try {
    const documents: unknown[] = []
    for (const document of parseAllDocuments(body)) {
      if (document.errors.length) throw document.errors[0]
      const value: unknown = document.toJS({ maxAliasCount: MAX_YAML_ALIASES })
      // An alias inside the thing it is an alias of (`a: &x { b: *x }`) parses into a circular object, which JSON
      // cannot hold and nothing downstream could compare or store.
      JSON.stringify(value)
      if (value !== null && value !== undefined) documents.push(value)
      if (documents.length > MAX_DOCUMENTS) return { error: `Too many documents: at most ${MAX_DOCUMENTS}` }
    }
    return { documents }
  } catch (error) {
    const circular = error instanceof TypeError && /circular/i.test(error.message)
    return { error: circular ? 'Invalid YAML: an alias may not refer to a value that contains it' : clip(`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`, MAX_ERROR_LENGTH) }
  }
}
