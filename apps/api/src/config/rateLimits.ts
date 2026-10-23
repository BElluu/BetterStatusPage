import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { normalizeHeartbeatKey } from '../services/heartbeatKey.js'

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

/**
 * Heartbeats by key. Keyed on the credentials and the key together, so requests with a wrong token cannot use up the
 * budget of a real sender, and the limiter never stores more than a hash per distinct pair.
 */
export const HEARTBEAT_KEY_RATE_LIMIT = {
  groupId: 'heartbeat-key',
  max: 60,
  timeWindow: '1 minute',
  keyGenerator: (request: FastifyRequest) => {
    const { key = '' } = request.params as { key?: string }
    return createHash('sha256').update(`${request.headers.authorization ?? ''}\n${normalizeHeartbeatKey(key) ?? key}`).digest('hex')
  },
}

/** The public subscribe form sends email to whatever address is typed in — keep it tight. */
export const SUBSCRIBE_RATE_LIMIT = {
  groupId: 'public-subscribe',
  max: 5,
  timeWindow: '15 minutes',
}

/** Confirm, manage and unsubscribe links carry unguessable tokens; this only blunts guessing. */
export const SUBSCRIPTION_TOKEN_RATE_LIMIT = {
  groupId: 'public-subscription-token',
  max: 30,
  timeWindow: '15 minutes',
}

export const PUBLIC_FEED_RATE_LIMIT = {
  groupId: 'public-feed',
  max: 60,
  timeWindow: '1 minute',
}

/** Opening a live stream holds a connection; a reconnecting browser needs far fewer attempts than this. */
export const PUBLIC_EVENTS_RATE_LIMIT = {
  groupId: 'public-events',
  max: 30,
  timeWindow: '1 minute',
}

/** The JSON status API is meant to be polled by scripts and dashboards; responses are cached for 30 s. */
export const PUBLIC_API_RATE_LIMIT = {
  groupId: 'public-status-api',
  max: 120,
  timeWindow: '1 minute',
}
