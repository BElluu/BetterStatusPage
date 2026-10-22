import type { SseLimits } from '@better-kit/runtime'
import { readPositiveInteger } from './env.js'

export function getSseLimits(env: NodeJS.ProcessEnv = process.env): Partial<SseLimits> {
  return {
    maxClients: readPositiveInteger(env, 'SSE_MAX_CLIENTS', 1000),
    maxClientsPerIp: readPositiveInteger(env, 'SSE_MAX_CLIENTS_PER_IP', 10),
  }
}
