import type { SshConfig } from '@bsp/shared'
import { failed, withConversation, type CheckOutcome } from './probe.js'

/** RFC 4253 lets a server send text lines before its identification string; this many are tolerated. */
const MAX_PRELUDE_LINES = 20
const IDENTIFICATION = 'SSH-2.0-BetterStatusPage'

/** Reads the server's SSH identification string. No login is attempted, so no keys or passwords are needed. */
export async function checkSsh(config: SshConfig, timeoutMs: number): Promise<CheckOutcome> {
  const start = Date.now()
  try {
    return await withConversation({ ...config, tls: false, timeoutMs }, async (c) => {
      let banner: string | null = null
      for (let i = 0; i < MAX_PRELUDE_LINES && banner === null; i++) {
        const line = await c.readLine()
        // 255 bytes is the longest identification string the protocol allows.
        if (line.startsWith('SSH-')) banner = line.slice(0, 255)
      }
      if (banner === null) throw new Error('The server did not send an SSH identification string')
      // Answering politely keeps the server from logging a dropped handshake on every check.
      c.send(IDENTIFICATION)
      if (config.expectedBanner && !banner.includes(config.expectedBanner)) {
        throw new Error(`Identification string "${banner}" does not contain "${config.expectedBanner}"`)
      }
      return { status: 'up', responseMs: Date.now() - start, error: null, detail: banner } satisfies CheckOutcome
    })
  } catch (err) {
    return failed(err, start)
  }
}
