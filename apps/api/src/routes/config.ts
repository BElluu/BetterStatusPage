import type { FastifyInstance } from 'fastify'
import { Document, visit } from 'yaml'
import { buildConfigDocument, ConfigExportError } from '../services/configExport.js'

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

export async function configRoutes(app: FastifyInstance) {
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
}
