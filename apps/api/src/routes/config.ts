import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Document, parseAllDocuments, visit } from 'yaml'
import { tokenAllows } from '@bsp/shared'
import { requestIdentity, requireRole } from '../middleware/auth.js'
import { clip } from '../lib/clip.js'
import { auditActor } from '../services/audit.js'
import type { AuthIdentity } from '../services/authSession.js'
import { buildConfigDocuments, ConfigExportError, pickDocument, type ConfigDocument } from '../services/configExport.js'
import { ConfigInvalidError, DOCUMENT_KINDS, importConfig, kindsIn, type DocumentKind } from '../services/configImport.js'

/** A configuration is a few hundred kilobytes at most; this leaves room without letting a request tie up the parser. */
const BODY_LIMIT = 2 * 1024 * 1024
/** Anchors are legitimate in a hand-written file, but a few are plenty and unbounded aliases are a decompression bomb. */
const MAX_YAML_ALIASES = 20
const MAX_DOCUMENTS = 2_000
const YAML_TYPES = ['application/yaml', 'application/x-yaml', 'text/yaml']

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
function toYaml(value: unknown): string {
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
const toYamlStream = (documents: unknown[]) => documents.map(toYaml).join('---\n')

/** What a token must be allowed to do with each kind of document. */
const TOKEN_RESOURCE: Record<DocumentKind, string> = { Monitor: 'monitors', NotificationChannel: 'channels' }
/** Who may export and import: the people who may edit monitors and channels in the panel (administrators always may). */
const SESSION_ROLES = ['admin', 'operator']

/** The kinds `identity` may not read (or write), with the reason, or null when it may do all of them. */
function refusal(identity: AuthIdentity, kinds: Iterable<DocumentKind>, access: 'read' | 'write'): string | null {
  const refused: string[] = []
  for (const kind of kinds) {
    if (identity.apiToken) {
      const needed = `${TOKEN_RESOURCE[kind]}:${access}`
      if (!tokenAllows(identity.apiToken.scopes, needed)) refused.push(`${kind} (the token needs "${needed}")`)
    } else if (!SESSION_ROLES.includes(identity.role)) {
      refused.push(`${kind} (needs the operator role)`)
    }
  }
  return refused.length ? `You may not ${access === 'read' ? 'export' : 'import'}: ${refused.join(', ')}` : null
}

/** The documents of an import request: a YAML text with one or more documents. */
function readDocuments(body: unknown): { documents: unknown[] } | { error: string } {
  if (typeof body !== 'string') return { error: 'Send the documents as YAML' }
  // A `%YAML 1.1` line would switch the parser to rules under which `yes` is a boolean and `22:00` a number.
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
    return { error: circular ? 'Invalid YAML: an alias may not refer to a value that contains it' : clip(`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`, 300) }
  }
}

type ImportRequest = FastifyRequest<{ Body: unknown }>

export async function configRoutes(app: FastifyInstance) {
  // A YAML body is handed to the handler as text and parsed there, after the request has been authenticated.
  app.addContentTypeParser(YAML_TYPES, { parseAs: 'string', bodyLimit: BODY_LIMIT }, (_req, body, done) => done(null, body))

  // One monitor or channel (`?kind=Monitor&key=public-site`), or all of them, as YAML.
  app.get<{ Querystring: { kind?: string; key?: string } }>('/export', async (req, reply) => {
    const { kind, key } = req.query
    if (kind !== undefined && !(DOCUMENT_KINDS as readonly string[]).includes(kind)) {
      return reply.code(400).send({ error: `kind must be one of: ${DOCUMENT_KINDS.join(', ')}` })
    }
    if (kind !== undefined && !key) return reply.code(400).send({ error: `key is required to export a ${kind}` })

    const denied = refusal(requestIdentity(req), kind ? [kind as DocumentKind] : DOCUMENT_KINDS, 'read')
    if (denied) return reply.code(403).send({ error: denied })

    let documents: ConfigDocument[]
    try {
      documents = await buildConfigDocuments(kind ? { kind: kind as DocumentKind, key: key! } : undefined)
    } catch (error) {
      if (error instanceof ConfigExportError) return reply.code(409).send({ error: error.message })
      throw error
    }
    if (kind) {
      const found = pickDocument(documents, kind as DocumentKind, key)
      if (!found) return reply.code(404).send({ error: `There is no ${kind} with the key "${clip(String(key))}"` })
      return reply.type('application/yaml; charset=utf-8').send(toYaml(found))
    }
    return reply.type('application/yaml; charset=utf-8').send(toYamlStream(documents))
  })

  async function run(req: ImportRequest, reply: FastifyReply, dryRun: boolean) {
    const read = readDocuments(req.body)
    if ('error' in read) return reply.code(400).send({ error: read.error })
    if (read.documents.length === 0) return reply.code(400).send({ error: 'The file contains no documents' })
    const identity = requestIdentity(req)
    const denied = refusal(identity, kindsIn(read.documents), 'write')
    if (denied) return reply.code(403).send({ error: denied })

    try {
      return await importConfig(read.documents, { dryRun, actor: auditActor(identity), token: identity.apiToken })
    } catch (error) {
      if (error instanceof ConfigInvalidError) return reply.code(400).send({ error: error.message, problems: error.problems })
      throw error
    }
  }

  // Both check the caller before the body is read: parsing a 2 MiB file is work only someone who may import it may ask for.
  // What the caller may import is decided per kind of document once the file is read.
  const mayWriteSomething = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = requestIdentity(req).apiToken
    if (token && !Object.values(TOKEN_RESOURCE).some((resource) => tokenAllows(token.scopes, `${resource}:write`))) {
      return reply.code(403).send({ error: 'This token has no permission to import: it needs "monitors:write" or "channels:write"' })
    }
  }
  // Only YAML is read, and this is checked before the body is, so a JSON body is never parsed.
  const onlyYaml = async (req: FastifyRequest, reply: FastifyReply) => {
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    if (!YAML_TYPES.includes(type)) return reply.code(415).send({ error: 'Send the documents as YAML, with Content-Type: application/yaml' })
  }
  const options = { onRequest: [requireRole('operator'), mayWriteSomething, onlyYaml], bodyLimit: BODY_LIMIT }
  // What importing the documents would change, without changing anything.
  app.post<{ Body: unknown }>('/validate', options, (req, reply) => run(req, reply, true))
  // Makes the installation match the documents, completely or not at all.
  app.post<{ Body: unknown }>('/apply', options, (req, reply) => run(req, reply, false))
}
