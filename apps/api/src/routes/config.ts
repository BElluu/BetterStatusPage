import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Document, parse as parseYaml, visit } from 'yaml'
import { requestIdentity, requireRole } from '../middleware/auth.js'
import { clip } from '../lib/clip.js'
import { auditActor } from '../services/audit.js'
import { buildConfigDocument, ConfigExportError } from '../services/configExport.js'
import { ConfigInvalidError, importConfig } from '../services/configImport.js'

/** A configuration is a few hundred kilobytes at most; this leaves room without letting a request tie up the parser. */
const BODY_LIMIT = 2 * 1024 * 1024
/** Anchors are legitimate in a hand-written file, but a few are plenty and unbounded aliases are a decompression bomb. */
const MAX_YAML_ALIASES = 20

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

type ImportRequest = FastifyRequest<{ Querystring: { prune?: string; allowEmpty?: string }; Body: unknown }>

const isFlag = (value: string | undefined) => value === undefined || value === 'true' || value === 'false'

export async function configRoutes(app: FastifyInstance) {
  // A YAML body is handed to the handler as text and parsed there, after the request has been authenticated.
  app.addContentTypeParser(['application/yaml', 'application/x-yaml', 'text/yaml'], { parseAs: 'string', bodyLimit: BODY_LIMIT }, (_req, body, done) => done(null, body))

  // Monitors, notification channels and the status page layout as YAML (default) or JSON.
  app.get<{ Querystring: { format?: string } }>('/export', async (req, reply) => {
    const format = req.query.format ?? 'yaml'
    if (format !== 'yaml' && format !== 'json') return reply.code(400).send({ error: 'format must be yaml or json' })

    let document
    try {
      document = await buildConfigDocument()
    } catch (error) {
      if (error instanceof ConfigExportError) return reply.code(409).send({ error: error.message })
      throw error
    }
    if (format === 'json') return document
    return reply.type('application/yaml; charset=utf-8').send(toYaml(document))
  })

  async function run(req: ImportRequest, reply: FastifyReply, dryRun: boolean) {
    const { prune, allowEmpty } = req.query
    if (!isFlag(prune)) return reply.code(400).send({ error: 'prune must be true or false' })
    if (!isFlag(allowEmpty)) return reply.code(400).send({ error: 'allowEmpty must be true or false' })

    let document: unknown = req.body
    if (typeof document === 'string') {
      // A `%YAML 1.1` line would switch the parser to rules under which `yes` is a boolean and `22:00` a number.
      if (/^%YAML/m.test(document)) return reply.code(400).send({ error: 'Invalid YAML: %YAML directives are not supported' })
      try {
        document = parseYaml(document, { maxAliasCount: MAX_YAML_ALIASES })
      } catch (error) {
        return reply.code(400).send({ error: clip(`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`, 300) })
      }
    }

    try {
      return await importConfig(document, { dryRun, prune: prune === 'true', allowEmpty: allowEmpty === 'true', actor: auditActor(requestIdentity(req)) })
    } catch (error) {
      if (error instanceof ConfigInvalidError) return reply.code(400).send({ error: error.message, problems: error.problems })
      throw error
    }
  }

  // Both check the caller before the body is read: parsing a 2 MiB document is work only an administrator may ask for.
  const options = { onRequest: requireRole(), bodyLimit: BODY_LIMIT }
  // What importing the document would change, without changing anything.
  app.post<{ Querystring: { prune?: string; allowEmpty?: string }; Body: unknown }>('/validate', options, (req, reply) => run(req, reply, true))
  // Makes the installation match the document, completely or not at all.
  app.post<{ Querystring: { prune?: string; allowEmpty?: string }; Body: unknown }>('/apply', options, (req, reply) => run(req, reply, false))
}
