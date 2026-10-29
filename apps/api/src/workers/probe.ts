import { isIP, connect as tcpConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { MonitorStatus, SocketTlsConfig } from '@bsp/shared'
import type { VaultRef } from '@better-forge/contracts'
import { resolveVaultSecret } from '../kit/resolveSecret.js'
import { guardedLookup, refusalReason } from '../services/ssrfGuard.js'

/** What every checker of a monitor type returns. `detail` is a note on success that the test button shows. */
export interface CheckOutcome {
  status: MonitorStatus
  responseMs: number | null
  error: string | null
  detail?: string
}

export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // OpenSSL's own wording carries a build path and a code; what it means for the reader is this.
  return /wrong version number|packet length too long/.test(message) ? 'The server does not speak TLS on this port' : message
}

/** A lines-and-replies conversation with a service, bounded by one deadline for the whole check. */
export interface Conversation {
  /** The next line without its line ending. */
  readLine(): Promise<string>
  send(line: string): void
  /** Encrypts the connection in place (STARTTLS / STLS). */
  upgrade(): Promise<void>
  /** The certificate-level facts of an encrypted connection, or null while it is plain. */
  tls(): TLSSocket | null
  close(): void
}

export interface OpenOptions extends SocketTlsConfig {
  host: string
  port: number
  /** Encrypted from the first byte. */
  tls: boolean
  /** Host name sent for SNI and matched against the certificate; defaults to `host`. */
  servername?: string
  timeoutMs: number
}

/** The longest line, and the most text waiting to be read, that a server may send. */
const MAX_LINE = 64 * 1024
const MAX_BUFFERED = 1024 * 1024

function tlsOptions(opts: OpenOptions) {
  const name = opts.servername ?? opts.host
  return {
    // SNI must name a host, never an IP address.
    ...(isIP(name) ? {} : { servername: name }),
    ...(opts.tlsCa ? { ca: opts.tlsCa } : {}),
    rejectUnauthorized: opts.verifyTls !== false,
  }
}

/** Opens a connection to an address someone typed in. Resolves once it is connected (and encrypted, if asked). */
export function open(opts: OpenOptions): Promise<Conversation> {
  // An address literal is never resolved, so the lookup guard does not see it.
  const refused = refusalReason(opts.host)
  if (refused) return Promise.reject(new Error(`Refusing to connect to ${opts.host}: ${refused}`))

  const deadline = Date.now() + opts.timeoutMs
  const remaining = () => Math.max(1, deadline - Date.now())

  return new Promise((resolve, reject) => {
    let socket: Socket | TLSSocket
    let buffer = ''
    let failure: Error | null = null
    let ended = false
    let waiter: { resolve: (line: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | null = null

    const settleWaiter = () => {
      if (!waiter) return
      const newline = buffer.indexOf('\n')
      if (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        const w = waiter
        waiter = null
        clearTimeout(w.timer)
        w.resolve(line)
      } else if (ended && !failure && buffer) {
        // A server that hangs up without a final line ending still said what is in the buffer.
        const line = buffer
        buffer = ''
        const w = waiter
        waiter = null
        clearTimeout(w.timer)
        w.resolve(line)
      } else if (failure || ended) {
        const w = waiter
        waiter = null
        clearTimeout(w.timer)
        w.reject(failure ?? new Error('Connection closed by the server'))
      }
    }

    const attach = (s: Socket | TLSSocket) => {
      s.setEncoding('utf8')
      s.on('data', (chunk: string) => {
        buffer += chunk
        if (buffer.length > MAX_BUFFERED || buffer.length - (buffer.lastIndexOf('\n') + 1) > MAX_LINE) {
          failure = new Error('The server sent too much data')
          s.destroy()
        }
        settleWaiter()
      })
      s.on('error', (err) => { failure = err; settleWaiter() })
      s.on('close', () => { ended = true; settleWaiter() })
    }

    const conversation: Conversation = {
      readLine: () => new Promise<string>((res, rej) => {
        if (waiter) return rej(new Error('A read is already waiting for the server'))
        waiter = {
          resolve: res,
          reject: rej,
          timer: setTimeout(() => {
            waiter = null
            rej(new Error('Timed out waiting for the server'))
            socket.destroy()
          }, remaining()),
        }
        settleWaiter()
      }),
      send: (line) => { socket.write(`${line}\r\n`) },
      upgrade: () => new Promise<void>((res, rej) => {
        if (buffer) return rej(new Error('The server sent data before the encryption started'))
        socket.removeAllListeners('data')
        socket.removeAllListeners('error')
        socket.removeAllListeners('close')
        const secure = tlsConnect({ socket: socket as Socket, ...tlsOptions(opts) })
        const timer = setTimeout(() => { secure.destroy(); rej(new Error('TLS handshake timed out')) }, remaining())
        secure.once('secureConnect', () => { clearTimeout(timer); socket = secure; attach(secure); res() })
        secure.once('error', (err) => { clearTimeout(timer); rej(err) })
      }),
      tls: () => ('encrypted' in socket && socket.encrypted ? (socket as TLSSocket) : null),
      // `end` lets a QUIT still in the buffer reach the server; the destroy is for one that never hangs up.
      close: () => { socket.end(); setTimeout(() => socket.destroy(), 200).unref() },
    }

    const onFailed = (err: Error) => { socket?.destroy(); reject(err) }
    const timeout = setTimeout(() => onFailed(new Error('Connection timed out')), remaining())
    const connected = () => { clearTimeout(timeout); attach(socket); resolve(conversation) }

    if (opts.tls) {
      socket = tlsConnect({ host: opts.host, port: opts.port, lookup: guardedLookup(), ...tlsOptions(opts) })
      socket.once('secureConnect', connected)
    } else {
      socket = tcpConnect({ host: opts.host, port: opts.port, lookup: guardedLookup() })
      socket.once('connect', connected)
    }
    socket.once('error', (err) => { clearTimeout(timeout); onFailed(err) })
  })
}

/** Runs `session` against a fresh connection and always closes it. */
export async function withConversation<T>(opts: OpenOptions, session: (c: Conversation) => Promise<T>): Promise<T> {
  const conversation = await open(opts)
  try {
    return await session(conversation)
  } finally {
    conversation.close()
  }
}

/** Turns a thrown error into a failed result. */
export function failed(err: unknown, start: number): CheckOutcome {
  return { status: 'down', responseMs: Date.now() - start, error: errorText(err) }
}

/** The user name and password to sign in with: the vault secret when one is set, else the typed values. */
export async function resolveLogin(config: { username?: string; password?: string; vault?: VaultRef }): Promise<{ username: string; password: string }> {
  let username = config.username ?? ''
  let password = config.password ?? ''
  if (config.vault) {
    const secret = await resolveVaultSecret(config.vault)
    username = secret['username'] ?? secret['user'] ?? username
    password = secret['password'] ?? secret['value'] ?? password
  }
  return { username, password }
}

/** Credentials end up inside a protocol line, so a line break in them would let them inject commands. */
export function assertLineSafe(label: string, value: string): void {
  if (/[\r\n\0]/.test(value)) throw new Error(`${label} must not contain line breaks`)
}
