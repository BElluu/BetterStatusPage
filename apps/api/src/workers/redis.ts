import type { RedisConfig } from '@bsp/shared'
import { assertLineSafe, failed, resolveLogin, withConversation, type CheckOutcome, type Conversation } from './probe.js'

/** A command in the RESP wire format, so arguments may hold spaces. Lengths count bytes. */
const command = (...args: string[]): string =>
  `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}`).join('\r\n')}`

/** The reply to `args` as text; an error reply (`-ERR ...`) becomes a thrown error. */
async function call(c: Conversation, ...args: string[]): Promise<string> {
  c.send(command(...args))
  const reply = await c.readLine()
  if (reply.startsWith('-')) throw new Error(reply.slice(1))
  if (!reply.startsWith('+')) throw new Error(`Unexpected reply: ${reply.slice(0, 80)}`)
  return reply.slice(1)
}

/** Signs in when a password is configured, then expects PONG to PING. */
export async function checkRedis(config: RedisConfig, timeoutMs: number): Promise<CheckOutcome> {
  const start = Date.now()
  try {
    const { username, password } = await resolveLogin(config)
    // RESP sizes every argument, but a service that is not Redis would read a line break as the end of a command.
    assertLineSafe('User name', username)
    assertLineSafe('Password', password)
    return await withConversation({ ...config, tls: config.tls === true, timeoutMs }, async (c) => {
      if (password) await call(c, 'AUTH', ...(username ? [username] : []), password)
      const pong = await call(c, 'PING')
      if (pong !== 'PONG') throw new Error(`Expected PONG, got ${pong}`)
      return { status: 'up', responseMs: Date.now() - start, error: null, detail: password ? 'Authenticated, PING answered PONG' : 'PING answered PONG' } satisfies CheckOutcome
    })
  } catch (err) {
    return failed(err, start)
  }
}
