import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify'
import { tokenAllows } from '@better-kit/contracts'
import { clip, ConfigExportError, ConfigInvalidError, type Json } from './document.js'
import type { ConfigEngine } from './engine.js'
import { readDocuments, toYaml, toYamlStream } from './yaml.js'

/** A configuration is a few hundred kilobytes at most; this leaves room without letting a request tie up the parser. */
const BODY_LIMIT = 2 * 1024 * 1024
const YAML_TYPES = ['application/yaml', 'application/x-yaml', 'text/yaml']

/** Who may export and import one kind of document. */
export interface KindAccess {
  /** The API token permission prefix: `<resource>:read` to export, `<resource>:write` to import. */
  tokenResource: string
  /** The roles of a signed-in user who may export and import it. */
  roles: readonly string[]
  /** The role named in the message when a user may not. */
  roleLabel: string
  /** Left out of a full export for a reader who may not see it, instead of refusing the whole export. */
  optional?: boolean
}

/** The caller of a request, as far as the routes need to know. */
export interface ConfigCaller {
  role: string
  apiToken?: { scopes: readonly string[] } | undefined
}

export interface ConfigRoutesOptions<Actor> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  engine: ConfigEngine<any, any, Actor>
  access: Readonly<Record<string, KindAccess>>
  identity: (req: FastifyRequest) => ConfigCaller
  /** What the caller is recorded as in the audit log. */
  actor: (req: FastifyRequest) => Actor
  /** Hooks that run before a file is read (the application's own role check). */
  guards: readonly onRequestAsyncHookHandler[]
  /** Kinds a file needs permission for beyond the kinds of its documents (for example the kind a document links to). */
  linkedKinds?: (documents: unknown[]) => readonly string[]
}

/** The routes to export the configuration as YAML and to validate or apply a YAML file. A plugin to register with `app.register`. */
export function createConfigRoutes<Actor>(options: ConfigRoutesOptions<Actor>) {
  const { engine, access, identity } = options
  const kindNames = engine.kinds
  const tokenResources = kindNames.map((kind) => access[kind]!.tokenResource)

  /** The kinds `caller` may not read (or write), with the reason, or null when it may do all of them. */
  function refusal(caller: ConfigCaller, kinds: Iterable<string>, mode: 'read' | 'write'): string | null {
    const refused: string[] = []
    for (const kind of kinds) {
      const rule = access[kind]!
      if (caller.apiToken) {
        const needed = `${rule.tokenResource}:${mode}`
        if (!tokenAllows(caller.apiToken.scopes, needed)) refused.push(`${kind} (the token needs "${needed}")`)
      } else if (!rule.roles.includes(caller.role)) {
        refused.push(`${kind} (needs the ${rule.roleLabel} role)`)
      }
    }
    return refused.length ? `You may not ${mode === 'read' ? 'export' : 'import'}: ${refused.join(', ')}` : null
  }

  /** The kinds a file needs permission for: its own, and those its documents link to. */
  function kindsNeeded(documents: unknown[]): Set<string> {
    const kinds = engine.kindsIn(documents)
    for (const linked of options.linkedKinds?.(documents) ?? []) kinds.add(linked)
    return kinds
  }

  const optionalKinds = kindNames.filter((kind) => access[kind]!.optional)

  return async function configRoutes(app: FastifyInstance) {
    // A YAML body is handed to the handler as text and parsed there, after the request has been authenticated.
    app.addContentTypeParser(YAML_TYPES, { parseAs: 'string', bodyLimit: BODY_LIMIT }, (_req, body, done) => done(null, body))

    // One document (`?kind=Note&key=first`), or all of them, as YAML.
    app.get<{ Querystring: { kind?: string; key?: string } }>('/export', async (req, reply) => {
      const { kind, key } = req.query
      if (kind !== undefined && !kindNames.includes(kind)) {
        return reply.code(400).send({ error: `kind must be one of: ${kindNames.join(', ')}` })
      }
      if (kind !== undefined && !key) return reply.code(400).send({ error: `key is required to export a ${kind}` })

      const caller = identity(req)
      const denied = refusal(caller, kind ? [kind] : kindNames.filter((each) => !optionalKinds.includes(each)), 'read')
      if (denied) return reply.code(403).send({ error: denied })
      // Without a key a full export holds the optional kinds only for who may read them.
      const included = new Set(kindNames.filter((each) => !optionalKinds.includes(each) || refusal(caller, [each], 'read') === null))

      let documents: Json[]
      try {
        documents = await engine.exportDocuments(kind ? { kind, key: key! } : undefined, { included })
      } catch (error) {
        if (error instanceof ConfigExportError) return reply.code(409).send({ error: error.message })
        throw error
      }
      if (kind) {
        const found = engine.pickDocument(documents, kind, key)
        if (!found) return reply.code(404).send({ error: `There is no ${kind} with the key "${clip(String(key))}"` })
        return reply.type('application/yaml; charset=utf-8').send(toYaml(found))
      }
      return reply.type('application/yaml; charset=utf-8').send(toYamlStream(documents))
    })

    async function run(req: FastifyRequest<{ Body: unknown }>, reply: FastifyReply, dryRun: boolean) {
      const read = readDocuments(req.body)
      if ('error' in read) return reply.code(400).send({ error: read.error })
      if (read.documents.length === 0) return reply.code(400).send({ error: 'The file contains no documents' })
      const caller = identity(req)
      const denied = refusal(caller, kindsNeeded(read.documents), 'write')
      if (denied) return reply.code(403).send({ error: denied })

      try {
        return await engine.importDocuments(read.documents, { dryRun, actor: options.actor(req), token: caller.apiToken })
      } catch (error) {
        if (error instanceof ConfigInvalidError) return reply.code(400).send({ error: error.message, problems: error.problems })
        throw error
      }
    }

    // Both check the caller before the body is read: parsing a 2 MiB file is work only someone who may import it may ask for.
    // What the caller may import is decided per kind of document once the file is read.
    const mayWriteSomething: onRequestAsyncHookHandler = async (req, reply) => {
      const token = identity(req).apiToken
      if (token && !tokenResources.some((resource) => tokenAllows(token.scopes, `${resource}:write`))) {
        const needs = tokenResources.map((resource) => `"${resource}:write"`)
        return reply.code(403).send({ error: `This token has no permission to import: it needs ${needs.slice(0, -1).join(', ')} or ${needs.at(-1)}` })
      }
    }
    // Only YAML is read, and this is checked before the body is, so a JSON body is never parsed.
    const onlyYaml: onRequestAsyncHookHandler = async (req, reply) => {
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      if (!YAML_TYPES.includes(type)) return reply.code(415).send({ error: 'Send the documents as YAML, with Content-Type: application/yaml' })
    }
    const routeOptions = { onRequest: [...options.guards, mayWriteSomething, onlyYaml], bodyLimit: BODY_LIMIT }
    // What importing the documents would change, without changing anything.
    app.post<{ Body: unknown }>('/validate', routeOptions, (req, reply) => run(req, reply, true))
    // Makes the installation match the documents, completely or not at all.
    app.post<{ Body: unknown }>('/apply', routeOptions, (req, reply) => run(req, reply, false))
  }
}
