import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { readDocuments, toYaml, toYamlStream } from '@better-kit/config-as-code'
import { tokenAllows } from '@better-kit/contracts'
import { requestIdentity, requireRole } from '../middleware/auth.js'
import { clip } from '../lib/clip.js'
import { auditActor } from '../services/audit.js'
import type { AuthIdentity } from '../services/authSession.js'
import { buildConfigDocuments, ConfigExportError, pickDocument, type ConfigDocument } from '../services/configExport.js'
import { ConfigInvalidError, DOCUMENT_KINDS, importConfig, kindsIn, type DocumentKind } from '../services/configImport.js'

/** A configuration is a few hundred kilobytes at most; this leaves room without letting a request tie up the parser. */
const BODY_LIMIT = 2 * 1024 * 1024
const YAML_TYPES = ['application/yaml', 'application/x-yaml', 'text/yaml']

/** What a token must be allowed to do with each kind of document. */
const TOKEN_RESOURCE: Record<DocumentKind, string> = { Monitor: 'monitors', NotificationChannel: 'channels', Action: 'actions' }
/** Who may export and import: the people who may edit monitors and channels in the panel (administrators always may). Actions are for administrators only. */
const SESSION_ROLES: Record<DocumentKind, string[]> = { Monitor: ['admin', 'operator'], NotificationChannel: ['admin', 'operator'], Action: ['admin'] }
/** Actions came after the other kinds: a full export leaves them out for a reader who may not see them, instead of refusing. */
const OPTIONAL_KINDS: DocumentKind[] = ['Action']

/** The kinds `identity` may not read (or write), with the reason, or null when it may do all of them. */
function refusal(identity: AuthIdentity, kinds: Iterable<DocumentKind>, access: 'read' | 'write'): string | null {
  const refused: string[] = []
  for (const kind of kinds) {
    if (identity.apiToken) {
      const needed = `${TOKEN_RESOURCE[kind]}:${access}`
      if (!tokenAllows(identity.apiToken.scopes, needed)) refused.push(`${kind} (the token needs "${needed}")`)
    } else if (!SESSION_ROLES[kind].includes(identity.role)) {
      refused.push(`${kind} (needs the ${kind === 'Action' ? 'admin' : 'operator'} role)`)
    }
  }
  return refused.length ? `You may not ${access === 'read' ? 'export' : 'import'}: ${refused.join(', ')}` : null
}

/** The kinds a file needs permission for: its own, and Action for a monitor that carries an `actions` list. */
function kindsNeeded(documents: unknown[]): Set<DocumentKind> {
  const kinds = kindsIn(documents)
  const linksActions = documents.some((document) => !!document && typeof document === 'object' && (document as { kind?: unknown }).kind === 'Monitor' && 'actions' in (document as object))
  if (linksActions) kinds.add('Action')
  return kinds
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

    const identity = requestIdentity(req)
    const denied = refusal(identity, kind ? [kind as DocumentKind] : DOCUMENT_KINDS.filter((each) => !OPTIONAL_KINDS.includes(each)), 'read')
    if (denied) return reply.code(403).send({ error: denied })
    // Without a key a full export holds actions, and the actions of every monitor, only for who may read them.
    const includeActions = kind === 'Action' || refusal(identity, ['Action'], 'read') === null
    if (kind === 'Action' && !includeActions) return reply.code(403).send({ error: refusal(identity, ['Action'], 'read') })

    let documents: ConfigDocument[]
    try {
      documents = await buildConfigDocuments(kind ? { kind: kind as DocumentKind, key: key! } : undefined, { includeActions })
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
    const denied = refusal(identity, kindsNeeded(read.documents), 'write')
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
      return reply.code(403).send({ error: 'This token has no permission to import: it needs "monitors:write", "channels:write" or "actions:write"' })
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
