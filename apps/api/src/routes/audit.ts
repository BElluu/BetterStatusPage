import type { FastifyInstance } from 'fastify'
import { audit } from '../kit/audit.js'

// The audit log route lives in the audit package; this keeps the old registration point.
export async function auditRoutes(app: FastifyInstance) {
  await audit.routes(app, {})
}
