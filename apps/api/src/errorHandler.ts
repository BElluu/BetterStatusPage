import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Unexpected failures are logged in full but never echoed to the client: driver errors carry the
 * SQL and its parameters, which can include encrypted secrets. Client errors (4xx) keep their
 * message in the `{ error }` shape the admin and status clients read.
 */
export function errorHandler(error: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500
  if (statusCode >= 500) {
    req.log.error({ err: error }, 'Unhandled request error')
    return reply.code(statusCode).send({ error: 'Internal Server Error' })
  }
  return reply.code(statusCode).send({ error: error.message })
}
