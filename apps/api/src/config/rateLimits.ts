import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'

export const LOGIN_RATE_LIMIT = {
  groupId: 'auth-login',
  max: 10,
  timeWindow: '15 minutes',
}

export const SENSITIVE_ACTION_RATE_LIMIT = {
  groupId: 'sensitive-action',
  max: 5,
  timeWindow: '15 minutes',
}

export const SETUP_RATE_LIMIT = {
  groupId: 'setup',
  max: 5,
  timeWindow: '15 minutes',
}

export const PUBLIC_HISTORY_RATE_LIMIT = {
  groupId: 'public-history',
  max: 300,
  timeWindow: '1 minute',
}

export const WEBHOOK_RATE_LIMIT = {
  groupId: 'webhook',
  max: 60,
  timeWindow: '1 minute',
  keyGenerator: (request: FastifyRequest) => {
    const { token = '' } = request.params as { token?: string }
    return createHash('sha256').update(token).digest('hex')
  },
}
