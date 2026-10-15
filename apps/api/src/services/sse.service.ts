import { sse } from '../kit/runtime.js'

export type { EventStreamOptions, SseFilter } from '@better-kit/runtime'
export const { sseService, serveEventStream } = sse
