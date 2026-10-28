import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer, type Server, type Socket } from 'node:net'
import { createServer as createTlsServer, TLSSocket } from 'node:tls'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { monitors, vaults, vaultSecrets } from '../src/db/schema.js'
import { encrypt } from '../src/kit/secretBox.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { parseNewMonitor } from '../src/services/monitorInput.js'
import { SECRET_MASK } from '../src/services/secretFields.js'
import { checkDomainExpiry, clearDomainCache, lookupExpiry, normalizeDomain, parseRdapExpiry, parseWhoisDate, parseWhoisExpiry, rdapBase } from '../src/workers/domainExpiry.js'
import { checkMail } from '../src/workers/mail.js'
import { checkOracle, oracleConnectString, parseOracleLogin } from '../src/workers/oracle.js'
import { checkRedis } from '../src/workers/redis.js'
import { validateMonitorConfig as validateServiceConfig } from '../src/services/monitorConfigSchema.js'
import { checkSsh } from '../src/workers/ssh.js'
import { checkTlsCert, expiryOutcome } from '../src/workers/tlsCert.js'
import { testDomain, testMail, testRedis, testSsh, testTlsCert } from '../src/workers/testRunner.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-service-monitors-')

// A self-signed certificate valid for 100 years, checked in so the tests need no openssl.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url))
const tls = { key: fixture('self-signed-key.pem'), cert: fixture('self-signed-cert.pem') }

// ── Fake servers ──────────────────────────────────────────────────────────────

/** What a handler may answer a line with: nothing, or a request to encrypt the connection from here on. */
type Reply = void | 'upgrade'

interface Fake {
  port: number
  /** Every line the server received, across all connections. */
  received: string[]
  close(): Promise<void>
}

/**
 * A line-oriented server. `onLine` answers with `say`; returning `'upgrade'` wraps the connection in TLS
 * once the answer is out, the way STARTTLS does.
 */
async function fake(opts: { greeting?: string; implicitTls?: boolean; onLine: (line: string, say: (text: string) => void, socket: Socket) => Reply }): Promise<Fake> {
  const received: string[] = []
  const sockets = new Set<Socket>()
  const attach = (socket: Socket) => {
    let buffer = ''
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i).replace(/\r$/, '')
        buffer = buffer.slice(i + 1)
        received.push(line)
        if (opts.onLine(line, (text) => socket.write(`${text}\r\n`), socket) === 'upgrade') {
          socket.removeAllListeners('data')
          attach(new TLSSocket(socket, { isServer: true, ...tls }))
          return
        }
      }
    })
  }
  const onConnection = (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    if (opts.greeting) socket.write(`${opts.greeting}\r\n`)
    attach(socket)
  }
  const server: Server = opts.implicitTls ? createTlsServer(tls, onConnection) : createServer(onConnection)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    received,
    close: () => new Promise<void>((resolve) => { sockets.forEach((s) => s.destroy()); server.close(() => resolve()) }),
  }
}

/** A Redis that understands AUTH and PING; commands arrive in the RESP array format. */
function fakeRedis(opts: { password?: string; user?: string; implicitTls?: boolean; pingReply?: string } = {}) {
  let args: string[] = []
  let expected = 0
  let authed = !opts.password
  return fake({
    implicitTls: opts.implicitTls ?? false,
    onLine(line, say) {
      if (line.startsWith('*')) { expected = Number(line.slice(1)); args = []; return }
      if (line.startsWith('$')) return
      args.push(line)
      if (args.length < expected) return
      if (args[0] === 'AUTH') {
        const [user, password] = args.length === 3 ? [args[1], args[2]] : [undefined, args[1]]
        if (password === opts.password && user === opts.user) { authed = true; say('+OK') } else say('-WRONGPASS invalid username-password pair')
      } else if (args[0] === 'PING') {
        say(authed ? (opts.pingReply ?? '+PONG') : '-NOAUTH Authentication required.')
      }
    },
  })
}

const base64 = (text: string) => Buffer.from(text).toString('base64')

function fakeSmtp(opts: { starttls?: boolean; auth?: { user: string; password: string }; implicitTls?: boolean } = {}) {
  let encrypted = opts.implicitTls ?? false
  return fake({
    greeting: '220 mail.test ESMTP ready',
    implicitTls: opts.implicitTls ?? false,
    onLine(line, say) {
      if (line.startsWith('EHLO')) {
        say('250-mail.test')
        if (opts.starttls && !encrypted) say('250-STARTTLS')
        if (opts.auth && (encrypted || !opts.starttls)) say('250-AUTH PLAIN LOGIN')
        say('250 8BITMIME')
      } else if (line === 'STARTTLS') {
        say('220 Ready to start TLS')
        encrypted = true
        return 'upgrade'
      } else if (line.startsWith('AUTH PLAIN ')) {
        say(line === `AUTH PLAIN ${base64(`\0${opts.auth?.user}\0${opts.auth?.password}`)}` ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication credentials invalid')
      }
    },
  })
}

function fakeImap(opts: { starttls?: boolean; user?: string; password?: string; implicitTls?: boolean } = {}) {
  return fake({
    greeting: '* OK IMAP4rev1 ready',
    implicitTls: opts.implicitTls ?? false,
    onLine(line, say) {
      const [tag, verb] = line.split(' ')
      if (verb === 'STARTTLS') {
        say(`${tag} OK Begin TLS negotiation now`)
        return 'upgrade'
      }
      if (verb === 'LOGIN') {
        say('* CAPABILITY IMAP4rev1')
        const ok = line === `${tag} LOGIN ${JSON.stringify(opts.user)} ${JSON.stringify(opts.password)}`
        say(ok ? `${tag} OK Logged in` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`)
      }
    },
  })
}

function fakePop3(opts: { user?: string; password?: string; implicitTls?: boolean } = {}) {
  let user = ''
  return fake({
    greeting: '+OK POP3 ready',
    implicitTls: opts.implicitTls ?? false,
    onLine(line, say) {
      if (line === 'STLS') { say('+OK Begin TLS negotiation'); return 'upgrade' }
      if (line.startsWith('USER ')) { user = line.slice(5); say('+OK') }
      else if (line.startsWith('PASS ')) say(user === opts.user && line.slice(5) === opts.password ? '+OK Logged in' : '-ERR [AUTH] Authentication failed')
    },
  })
}

const servers: Fake[] = []
const track = async (pending: Promise<Fake>): Promise<Fake> => { const f = await pending; servers.push(f); return f }
after(async () => { await Promise.all(servers.map((s) => s.close())) })

const HOST = '127.0.0.1'
/** The server sees the last lines a moment after the check has returned. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

// ── Oracle ────────────────────────────────────────────────────────────────────

describe('Oracle monitor', () => {
  it('reads user, password and connect string from the sqlplus form', () => {
    assert.deepEqual(parseOracleLogin('mon/monpw@db.test:1521/FREEPDB1'), { user: 'mon', password: 'monpw', connectString: 'db.test:1521/FREEPDB1' })
    // As in sqlplus, the first / ends the user name and the first @ ends the password, which may hold other /.
    assert.deepEqual(parseOracleLogin(' mon/p/w@tcps://db.test:2484/S '), { user: 'mon', password: 'p/w', connectString: 'tcps://db.test:2484/S' })
    assert.deepEqual(parseOracleLogin('mon/pw@(DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=h)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=s)))').connectString, '(DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=h)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=s)))')
    for (const bad of ['', 'garbage', 'user@db', '/pw@db', 'user/pw@']) assert.throws(() => parseOracleLogin(bad), /must look like/, bad)
  })

  it('uses tcps only for a verified connection', () => {
    const c = { host: 'db.test', port: 1521, database: 'SVC', user: 'u', password: 'p' }
    assert.equal(oracleConnectString({ ...c, tls: 'verify' }), 'tcps://db.test:1521/SVC')
    assert.equal(oracleConnectString({ ...c, tls: 'prefer' }), 'db.test:1521/SVC')
  })

  it('refuses the mode that would encrypt without checking the certificate, before connecting', async () => {
    const result = await checkOracle({ host: HOST, port: 1, database: 'S', user: 'u', password: 'p', query: '', tls: 'require' }, 1_000)
    assert.equal(result.status, 'down')
    assert.match(result.error ?? '', /cannot encrypt without checking the certificate/)
  })

  it('is down when nothing listens', async () => {
    const closed = await fake({ onLine: () => {} })
    await closed.close()
    const result = await checkOracle({ host: HOST, port: closed.port, database: 'S', user: 'u', password: 'p', query: '', tls: 'prefer' }, 2_000)
    assert.equal(result.status, 'down')
    assert.ok(result.error)
  })
})

// ── Redis ─────────────────────────────────────────────────────────────────────

describe('Redis monitor', () => {
  it('is up when PING answers PONG', async () => {
    const redis = await track(fakeRedis())
    const result = await checkRedis({ host: HOST, port: redis.port }, 2_000)
    assert.equal(result.status, 'up')
    assert.equal(result.error, null)
    assert.deepEqual(redis.received, ['*1', '$4', 'PING'])
  })

  it('signs in with a password, and with a user name and password, sending them as sized arguments', async () => {
    const withPassword = await track(fakeRedis({ password: 'pass word' }))
    assert.equal((await checkRedis({ host: HOST, port: withPassword.port, password: 'pass word' }, 2_000)).status, 'up')
    assert.deepEqual(withPassword.received.slice(0, 5), ['*2', '$4', 'AUTH', '$9', 'pass word'])

    const withUser = await track(fakeRedis({ password: 'pw', user: 'alice' }))
    assert.equal((await checkRedis({ host: HOST, port: withUser.port, username: 'alice', password: 'pw' }, 2_000)).status, 'up')
  })

  it('reports the server\'s error for a wrong or missing password', async () => {
    const redis = await track(fakeRedis({ password: 'right' }))
    const wrong = await checkRedis({ host: HOST, port: redis.port, password: 'wrong' }, 2_000)
    assert.equal(wrong.status, 'down')
    assert.match(wrong.error ?? '', /^WRONGPASS/)
    const missing = await checkRedis({ host: HOST, port: redis.port }, 2_000)
    assert.match(missing.error ?? '', /^NOAUTH/)
  })

  it('is down when the server does not answer PONG', async () => {
    const odd = await track(fakeRedis({ pingReply: '+LOADING' }))
    assert.match((await checkRedis({ host: HOST, port: odd.port }, 2_000)).error ?? '', /Expected PONG, got LOADING/)
    const notRedis = await track(fake({ onLine: (_line, say) => say('HTTP/1.1 400 Bad Request') }))
    assert.match((await checkRedis({ host: HOST, port: notRedis.port }, 2_000)).error ?? '', /Unexpected reply/)
  })

  it('is down on a closed port and on a silent server', async () => {
    const silent = await track(fake({ onLine: () => {} }))
    const timedOut = await checkRedis({ host: HOST, port: silent.port }, 300)
    assert.equal(timedOut.status, 'down')
    assert.match(timedOut.error ?? '', /Timed out/)
    const closed = await fake({ onLine: () => {} })
    await closed.close()
    assert.equal((await checkRedis({ host: HOST, port: closed.port }, 1_000)).status, 'down')
  })

  it('connects over TLS, and checks the certificate unless told not to', async () => {
    const redis = await track(fakeRedis({ implicitTls: true }))
    assert.equal((await checkRedis({ host: HOST, port: redis.port, tls: true, verifyTls: false }, 2_000)).status, 'up')
    const strict = await checkRedis({ host: HOST, port: redis.port, tls: true }, 2_000)
    assert.equal(strict.status, 'down')
    assert.match(strict.error ?? '', /self-signed|self signed/)
    const trusted = await checkRedis({ host: 'localhost', port: redis.port, tls: true, tlsCa: tls.cert.toString() }, 2_000)
    assert.equal(trusted.status, 'up', trusted.error ?? '')
  })

  it('refuses a cloud metadata address', async () => {
    const result = await checkRedis({ host: '169.254.169.254', port: 6379 }, 1_000)
    assert.match(result.error ?? '', /Refusing to connect/)
  })
})

// ── Mail ──────────────────────────────────────────────────────────────────────

describe('SMTP monitor', () => {
  it('greets, says EHLO and quits', async () => {
    const smtp = await track(fakeSmtp())
    const result = await checkMail({ protocol: 'smtp', host: HOST, port: smtp.port, security: 'none' }, 2_000)
    assert.equal(result.status, 'up', result.error ?? '')
    assert.match(result.detail ?? '', /^220 mail\.test/)
    await settle()
    assert.deepEqual(smtp.received, ['EHLO betterstatuspage.local', 'QUIT'])
  })

  it('upgrades with STARTTLS, says EHLO again and signs in with AUTH PLAIN', async () => {
    const smtp = await track(fakeSmtp({ starttls: true, auth: { user: 'me', password: 'pw' } }))
    const result = await checkMail({ protocol: 'smtp', host: HOST, port: smtp.port, security: 'starttls', verifyTls: false, username: 'me', password: 'pw' }, 2_000)
    assert.equal(result.status, 'up', result.error ?? '')
    assert.match(result.detail ?? '', /signed in/)
    await settle()
    assert.deepEqual(smtp.received.map((l) => l.split(' ')[0]), ['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'QUIT'])
  })

  it('refuses to continue when STARTTLS is asked for but not offered', async () => {
    const smtp = await track(fakeSmtp())
    const result = await checkMail({ protocol: 'smtp', host: HOST, port: smtp.port, security: 'starttls' }, 2_000)
    assert.match(result.error ?? '', /does not offer STARTTLS/)
  })

  it('rejects bad credentials with the server\'s reply', async () => {
    const smtp = await track(fakeSmtp({ auth: { user: 'me', password: 'pw' } }))
    const result = await checkMail({ protocol: 'smtp', host: HOST, port: smtp.port, security: 'none', username: 'me', password: 'nope' }, 2_000)
    assert.equal(result.status, 'down')
    assert.match(result.error ?? '', /^Sign-in: 535/)
  })

  it('says so when no sign-in method is offered', async () => {
    const smtp = await track(fakeSmtp())
    const result = await checkMail({ protocol: 'smtp', host: HOST, port: smtp.port, security: 'none', username: 'me', password: 'pw' }, 2_000)
    assert.match(result.error ?? '', /does not offer AUTH PLAIN/)
  })

  it('works over implicit TLS, verifying the certificate by default', async () => {
    const smtp = await track(fakeSmtp({ implicitTls: true }))
    assert.equal((await checkMail({ protocol: 'smtp', host: HOST, port: smtp.port, security: 'tls', verifyTls: false }, 2_000)).status, 'up')
    assert.equal((await checkMail({ protocol: 'smtp', host: HOST, port: smtp.port, security: 'tls' }, 2_000)).status, 'down')
  })

  it('is down when the greeting is not a 220', async () => {
    const busy = await track(fake({ greeting: '554 no service', onLine: () => {} }))
    assert.match((await checkMail({ protocol: 'smtp', host: HOST, port: busy.port, security: 'none' }, 2_000)).error ?? '', /^Greeting: 554/)
  })
})

describe('reading from a server', () => {
  it('accepts a long answer made of many short lines', async () => {
    const smtp = await track(fake({
      greeting: '220 ready',
      onLine(line, say) {
        if (line.startsWith('EHLO')) { say(Array.from({ length: 90 }, () => `250-${'x'.repeat(1000)}`).join('\r\n')); say('250 done') }
      },
    }))
    const result = await checkMail({ protocol: 'smtp', host: HOST, port: smtp.port, security: 'none' }, 2_000)
    assert.equal(result.status, 'up', result.error ?? '')
  })

  it('fails on a line that never ends', async () => {
    const flood = createServer((socket) => { socket.on('error', () => {}); socket.write('x'.repeat(100_000)) })
    await new Promise<void>((resolve) => flood.listen(0, '127.0.0.1', resolve))
    servers.push({ port: 0, received: [], close: () => new Promise<void>((r) => flood.close(() => r())) })
    const result = await checkSsh({ host: HOST, port: (flood.address() as { port: number }).port }, 2_000)
    assert.equal(result.status, 'down')
    assert.equal(result.error, 'The server sent too much data')
  })

  it('returns the last line of a server that hangs up without ending it', async () => {
    const ssh = await new Promise<number>((resolve) => {
      const s = createServer((socket) => { socket.end('SSH-2.0-NoNewline') })
      s.listen(0, '127.0.0.1', () => { servers.push({ port: (s.address() as { port: number }).port, received: [], close: () => new Promise<void>((r) => s.close(() => r())) }); resolve((s.address() as { port: number }).port) })
    })
    const result = await checkSsh({ host: HOST, port: ssh }, 2_000)
    assert.equal(result.status, 'up', result.error ?? '')
    assert.equal(result.detail, 'SSH-2.0-NoNewline')
  })

  it('refuses data that arrives in the clear right after STARTTLS was agreed', async () => {
    const smtp = await track(fake({
      greeting: '220 ready',
      onLine(line, say) {
        if (line.startsWith('EHLO')) { say('250-mail.test'); say('250 STARTTLS') }
        else if (line === 'STARTTLS') { say('220 Go ahead\r\n250 injected'); return 'upgrade' }
      },
    }))
    const result = await checkMail({ protocol: 'smtp', host: HOST, port: smtp.port, security: 'starttls', verifyTls: false }, 2_000)
    assert.equal(result.status, 'down')
    assert.match(result.error ?? '', /before the encryption started/)
  })
})

describe('IMAP monitor', () => {
  it('logs in with quoted arguments and skips untagged lines', async () => {
    const imap = await track(fakeImap({ user: 'us"er', password: 'p\\w' }))
    const result = await checkMail({ protocol: 'imap', host: HOST, port: imap.port, security: 'none', username: 'us"er', password: 'p\\w' }, 2_000)
    assert.equal(result.status, 'up', result.error ?? '')
    await settle()
    assert.equal(imap.received[0], 'a2 LOGIN "us\\"er" "p\\\\w"')
    assert.equal(imap.received[1], 'a3 LOGOUT')
  })

  it('reports a refused login', async () => {
    const imap = await track(fakeImap({ user: 'me', password: 'pw' }))
    const result = await checkMail({ protocol: 'imap', host: HOST, port: imap.port, security: 'none', username: 'me', password: 'bad' }, 2_000)
    assert.match(result.error ?? '', /^Sign-in: a2 NO/)
  })

  it('upgrades with STARTTLS before logging in', async () => {
    const imap = await track(fakeImap({ user: 'me', password: 'pw' }))
    const result = await checkMail({ protocol: 'imap', host: HOST, port: imap.port, security: 'starttls', verifyTls: false, username: 'me', password: 'pw' }, 2_000)
    assert.equal(result.status, 'up', result.error ?? '')
    await settle()
    assert.deepEqual(imap.received.map((l) => l.split(' ')[1]), ['STARTTLS', 'LOGIN', 'LOGOUT'])
  })

  it('works over implicit TLS without credentials', async () => {
    const imap = await track(fakeImap({ implicitTls: true }))
    assert.equal((await checkMail({ protocol: 'imap', host: HOST, port: imap.port, security: 'tls', verifyTls: false }, 2_000)).status, 'up')
  })

  it('never sends a credential that carries a line break', async () => {
    const imap = await track(fakeImap({ user: 'me', password: 'pw' }))
    const result = await checkMail({ protocol: 'imap', host: HOST, port: imap.port, security: 'none', username: 'me', password: 'pw\r\na9 DELETE INBOX' }, 2_000)
    assert.match(result.error ?? '', /must not contain line breaks/)
    assert.deepEqual(imap.received, [])
  })
})

describe('POP3 monitor', () => {
  it('signs in with USER and PASS', async () => {
    const pop = await track(fakePop3({ user: 'me', password: 'pw' }))
    const result = await checkMail({ protocol: 'pop3', host: HOST, port: pop.port, security: 'none', username: 'me', password: 'pw' }, 2_000)
    assert.equal(result.status, 'up', result.error ?? '')
    await settle()
    assert.deepEqual(pop.received, ['USER me', 'PASS pw', 'QUIT'])
  })

  it('reports a refused login', async () => {
    const pop = await track(fakePop3({ user: 'me', password: 'pw' }))
    const result = await checkMail({ protocol: 'pop3', host: HOST, port: pop.port, security: 'none', username: 'me', password: 'bad' }, 2_000)
    assert.match(result.error ?? '', /^Sign-in: -ERR/)
  })

  it('upgrades with STLS', async () => {
    const pop = await track(fakePop3({ user: 'me', password: 'pw' }))
    const result = await checkMail({ protocol: 'pop3', host: HOST, port: pop.port, security: 'starttls', verifyTls: false, username: 'me', password: 'pw' }, 2_000)
    assert.equal(result.status, 'up', result.error ?? '')
    assert.equal(pop.received[0], 'STLS')
  })

  it('never sends a user name that carries a line break', async () => {
    const pop = await track(fakePop3({ user: 'me', password: 'pw' }))
    const result = await checkMail({ protocol: 'pop3', host: HOST, port: pop.port, security: 'none', username: 'me\r\nDELE 1', password: 'pw' }, 2_000)
    assert.match(result.error ?? '', /must not contain line breaks/)
    assert.deepEqual(pop.received, [])
  })
})

// ── SSH ───────────────────────────────────────────────────────────────────────

describe('SSH monitor', () => {
  it('reads the identification string, tolerating text before it, and answers with its own', async () => {
    const ssh = await track(fake({ greeting: 'Welcome\r\nSSH-2.0-OpenSSH_9.6 Ubuntu', onLine: () => {} }))
    const result = await checkSsh({ host: HOST, port: ssh.port }, 2_000)
    assert.equal(result.status, 'up', result.error ?? '')
    assert.equal(result.detail, 'SSH-2.0-OpenSSH_9.6 Ubuntu')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(ssh.received, ['SSH-2.0-BetterStatusPage'])
  })

  it('checks the expected text in the identification string', async () => {
    const ssh = await track(fake({ greeting: 'SSH-2.0-OpenSSH_9.6', onLine: () => {} }))
    assert.equal((await checkSsh({ host: HOST, port: ssh.port, expectedBanner: 'OpenSSH' }, 2_000)).status, 'up')
    const mismatch = await checkSsh({ host: HOST, port: ssh.port, expectedBanner: 'Dropbear' }, 2_000)
    assert.equal(mismatch.status, 'down')
    assert.match(mismatch.error ?? '', /does not contain "Dropbear"/)
  })

  it('is down for a service that does not speak SSH', async () => {
    const http = await track(fake({ greeting: 'HTTP/1.1 400 Bad Request', onLine: () => {} }))
    const result = await checkSsh({ host: HOST, port: http.port }, 500)
    assert.equal(result.status, 'down')
  })
})

// ── TLS certificate ───────────────────────────────────────────────────────────

describe('TLS certificate monitor', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('is up for a certificate far from expiry, naming it', async () => {
    const server = await track(fake({ implicitTls: true, onLine: () => {} }))
    const result = await checkTlsCert({ host: HOST, port: server.port, warnDays: 14, verifyTls: false }, 2_000)
    assert.equal(result.status, 'up', result.error ?? '')
    assert.match(result.detail ?? '', /^Certificate for localhost .* expires on 2126-09-24 \(in \d+ days\)$/)
  })

  it('turns Degraded inside the warning window and Down once expired', async () => {
    const server = await track(fake({ implicitTls: true, onLine: () => {} }))
    const expiry = Date.UTC(2126, 8, 24, 16, 2, 31)
    const options = { host: HOST, port: server.port, warnDays: 14, verifyTls: false }
    const soon = await checkTlsCert(options, 2_000, expiry - 4.5 * DAY)
    assert.equal(soon.status, 'degraded')
    assert.match(soon.error ?? '', /in 4 days/)
    const expired = await checkTlsCert(options, 2_000, expiry + DAY)
    assert.equal(expired.status, 'down')
    assert.match(expired.error ?? '', /expired on 2126-09-24/)
  })

  it('is down for an untrusted certificate unless verification is off or the authority is given', async () => {
    const server = await track(fake({ implicitTls: true, onLine: () => {} }))
    const strict = await checkTlsCert({ host: HOST, port: server.port, warnDays: 14 }, 2_000)
    assert.equal(strict.status, 'down')
    assert.match(strict.error ?? '', /self-signed|self signed/)
    const trusted = await checkTlsCert({ host: 'localhost', port: server.port, warnDays: 14, tlsCa: tls.cert.toString() }, 2_000)
    assert.equal(trusted.status, 'up', trusted.error ?? '')
  })

  it('is down with a readable message for a port without TLS', async () => {
    const plain = await track(fake({ greeting: 'hello', onLine: () => {} }))
    const result = await checkTlsCert({ host: HOST, port: plain.port, warnDays: 14 }, 2_000)
    assert.equal(result.status, 'down')
    assert.equal(result.error, 'The server does not speak TLS on this port')
  })

  it('words the days left in the singular and plural', () => {
    const now = Date.UTC(2026, 0, 1)
    assert.equal(expiryOutcome('X', now + 1.5 * DAY, 3, now).error, 'X expires on 2026-01-02 (in 1 day)')
    assert.equal(expiryOutcome('X', now + 40 * DAY, 3, now).status, 'up')
    assert.equal(expiryOutcome('X', now + 3 * DAY, 3, now).status, 'up')
    assert.equal(expiryOutcome('X', now + 2.5 * DAY, 3, now).status, 'degraded')
  })
})

// ── Domain expiry ─────────────────────────────────────────────────────────────

describe('domain expiry monitor', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('normalizes and validates domain names', () => {
    assert.equal(normalizeDomain(' Example.COM. '), 'example.com')
    assert.equal(normalizeDomain('xn--bcher-kva.example'), 'xn--bcher-kva.example')
    for (const bad of ['', 'localhost', 'not a domain', 'a..b.com', '-a.com', 'a.com/path', 'https://a.com', '1.2.3.4']) assert.equal(normalizeDomain(bad), null, bad)
  })

  it('finds the RDAP server of a TLD in the IANA bootstrap data', () => {
    const bootstrap = { services: [[['com', 'net'], ['https://rdap.verisign.com/com/v1/']], [['dev'], ['http://a.example/', 'https://b.example']]] as [string[], string[]][] }
    assert.equal(rdapBase(bootstrap, 'com'), 'https://rdap.verisign.com/com/v1/')
    assert.equal(rdapBase(bootstrap, 'dev'), 'https://b.example/')
    assert.equal(rdapBase(bootstrap, 'pl'), null)
  })

  it('reads the expiration event of an RDAP answer', () => {
    const answer = { events: [{ eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-08-13T04:00:00Z' }] }
    assert.equal(parseRdapExpiry(answer), Date.UTC(2027, 7, 13, 4))
    assert.equal(parseRdapExpiry({ events: [] }), null)
    assert.equal(parseRdapExpiry(null), null)
    assert.equal(parseRdapExpiry({ events: [{ eventAction: 'expiration', eventDate: 'soon' }] }), null)
  })

  it('reads the dates registries write in WHOIS answers', () => {
    assert.equal(parseWhoisDate('2026-12-22T10:30:00Z'), Date.UTC(2026, 11, 22, 10, 30))
    assert.equal(parseWhoisDate('2026.12.22 13:00:00'), Date.UTC(2026, 11, 22, 13))
    assert.equal(parseWhoisDate('22-Dec-2026'), Date.UTC(2026, 11, 22))
    assert.equal(parseWhoisDate('22 December 2026'), Date.UTC(2026, 11, 22))
    assert.equal(parseWhoisDate('never'), null)
    assert.equal(parseWhoisExpiry('Domain Name: EXAMPLE.COM\nRegistry Expiry Date: 2027-08-13T04:00:00Z\nRegistrar: X'), Date.UTC(2027, 7, 13, 4))
    assert.equal(parseWhoisExpiry('DOMAIN NAME:  allegro.pl\nrenewal date:   2027.10.26 12:00:00\n'), Date.UTC(2027, 9, 26, 12))
    assert.equal(parseWhoisExpiry('Domain name:\n    example.co.uk\n\n    Expiry date:  22-Dec-2026\n'), Date.UTC(2026, 11, 22))
    assert.equal(parseWhoisExpiry('paid-till: 2027-01-05T00:00:00Z'), Date.UTC(2027, 0, 5))
    assert.equal(parseWhoisExpiry('No match for domain'), null)
  })

  it('judges the expiry: up, degraded inside the window, down once expired', async () => {
    clearDomainCache()
    const now = Date.UTC(2026, 9, 26)
    const at = (days: number) => async () => now + days * DAY
    const config = { domain: 'example.com', warnDays: 30 }
    const far = await checkDomainExpiry(config, 1_000, { now, lookup: at(200) })
    assert.equal(far.status, 'up')
    assert.equal(far.detail, 'Domain example.com expires on 2027-05-14 (in 200 days)')
    clearDomainCache()
    const near = await checkDomainExpiry(config, 1_000, { now, lookup: at(10) })
    assert.equal(near.status, 'degraded')
    clearDomainCache()
    const gone = await checkDomainExpiry(config, 1_000, { now, lookup: at(-2) })
    assert.equal(gone.status, 'down')
    assert.match(gone.error ?? '', /expired on 2026-10-24/)
  })

  it('does not ask again right after a lookup failed, but does once the failure has aged', async () => {
    clearDomainCache()
    const now = Date.UTC(2026, 9, 26)
    let lookups = 0
    const lookup = async () => { lookups++; throw new Error('registry refused') }
    const config = { domain: 'refused.test', warnDays: 30 }
    for (const at of [0, 5 * 60 * 1000, 20 * 60 * 1000]) {
      const result = await checkDomainExpiry(config, 1_000, { now: now + at, lookup })
      assert.equal(result.error, 'registry refused')
    }
    assert.equal(lookups, 1)
    await checkDomainExpiry(config, 1_000, { now: now + 31 * 60 * 1000, lookup })
    assert.equal(lookups, 2)
  })

  it('looks a domain up once per cache period and reports lookup failures', async () => {
    clearDomainCache()
    const now = Date.UTC(2026, 9, 26)
    let lookups = 0
    const lookup = async () => { lookups++; return now + 100 * DAY }
    const config = { domain: 'Example.com.', warnDays: 30 }
    await checkDomainExpiry(config, 1_000, { now, lookup })
    await checkDomainExpiry(config, 1_000, { now: now + 5 * 60 * 60 * 1000, lookup })
    assert.equal(lookups, 1)
    await checkDomainExpiry(config, 1_000, { now: now + 7 * 60 * 60 * 1000, lookup })
    assert.equal(lookups, 2)

    clearDomainCache()
    const failing = await checkDomainExpiry({ domain: 'other.com', warnDays: 30 }, 1_000, { now, lookup: async () => { throw new Error('RDAP down') } })
    assert.equal(failing.status, 'down')
    assert.equal(failing.error, 'RDAP down')
    assert.match((await checkDomainExpiry({ domain: 'not a domain', warnDays: 30 }, 1_000)).error ?? '', /is not a domain name/)
  })
})

// ── Registry lookups over the network ───────────────────────────────────────────

describe('domain registry lookups', () => {

  async function registry(opts: { bootstrap: unknown; rdap?: (path: string) => { status: number; body?: unknown } }) {
    let rdapBase = ''
    const http = createHttpServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/bootstrap') { res.end(JSON.stringify(typeof opts.bootstrap === 'function' ? (opts.bootstrap as (b: string) => unknown)(rdapBase) : opts.bootstrap)); return }
      const answer = opts.rdap?.(req.url ?? '') ?? { status: 404 }
      res.statusCode = answer.status
      res.end(JSON.stringify(answer.body ?? {}))
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const port = (http.address() as { port: number }).port
    rdapBase = `http://127.0.0.1:${port}/rdap/`
    servers.push({ port, received: [], close: () => new Promise<void>((resolve) => http.close(() => resolve())) })
    return { bootstrapUrl: `http://127.0.0.1:${port}/bootstrap`, rdapBase }
  }

  it('asks the RDAP server the IANA bootstrap names, for the domain only', async () => {
    clearDomainCache()
    const seenPaths: string[] = []
    const reg = await registry({
      bootstrap: (base: string) => ({ services: [[['test'], [base]]] }),
      rdap: (path) => { seenPaths.push(path); return { status: 200, body: { events: [{ eventAction: 'expiration', eventDate: '2030-01-02T03:04:05Z' }] } } },
    })
    const expiresAt = await lookupExpiry('example.test', 2_000, { bootstrapUrl: reg.bootstrapUrl, ianaWhoisHost: HOST, whoisPort: 1 })
    assert.equal(expiresAt, Date.UTC(2030, 0, 2, 3, 4, 5))
    assert.deepEqual(seenPaths, ['/rdap/domain/example.test'])
  })

  it('reports an unregistered domain, an RDAP error and an answer without an expiry date', async () => {
    clearDomainCache()
    const reg = await registry({
      bootstrap: (base: string) => ({ services: [[['test'], [base]]] }),
      rdap: (path) => path.endsWith('/gone.test') ? { status: 404 } : path.endsWith('/broken.test') ? { status: 503 } : { status: 200, body: { events: [] } },
    })
    const ep = { bootstrapUrl: reg.bootstrapUrl, ianaWhoisHost: HOST, whoisPort: 1 }
    await assert.rejects(lookupExpiry('gone.test', 2_000, ep), /gone\.test is not registered/)
    await assert.rejects(lookupExpiry('broken.test', 2_000, ep), /answered 503/)
    await assert.rejects(lookupExpiry('plain.test', 2_000, ep), /no expiration date/)
  })

  it('reports an IANA bootstrap that cannot be read', async () => {
    clearDomainCache()
    const down = await fake({ onLine: () => {} })
    await down.close()
    await assert.rejects(lookupExpiry('example.test', 1_000, { bootstrapUrl: `http://127.0.0.1:${down.port}/bootstrap`, ianaWhoisHost: HOST, whoisPort: 1 }))
  })

  it('falls back to WHOIS through the referral of IANA when the registry has no RDAP, and remembers the referral', async () => {
    clearDomainCache()
    const reg = await registry({ bootstrap: { services: [[['com'], ['https://rdap.example/']]] } })
    const asked: string[] = []
    const whois = await track(fake({
      onLine(line, say, socket) {
        asked.push(line)
        if (line === 'test') say('refer:    whois.example\r\nwhois:    127.0.0.1\r\n')
        else say('Domain Name: example.test\r\nrenewal date:   2031.05.06 07:08:09')
        socket.end()
      },
    }))
    const ep = { bootstrapUrl: reg.bootstrapUrl, ianaWhoisHost: HOST, whoisPort: whois.port }
    assert.equal(await lookupExpiry('example.test', 2_000, ep), Date.UTC(2031, 4, 6, 7, 8, 9))
    assert.equal(await lookupExpiry('other.test', 2_000, ep), Date.UTC(2031, 4, 6, 7, 8, 9))
    assert.deepEqual(asked, ['test', 'example.test', 'other.test'])
  })

  it('reports a WHOIS server that names no expiry date, and a TLD IANA does not know', async () => {
    clearDomainCache()
    const reg = await registry({ bootstrap: { services: [] } })
    const whois = await track(fake({
      onLine(line, say, socket) {
        if (line === 'test') say('whois:    127.0.0.1\r\n')
        else if (line === 'nowhere') say('% no whois server\r\n')
        else say('No match for domain')
        socket.end()
      },
    }))
    const ep = { bootstrapUrl: reg.bootstrapUrl, ianaWhoisHost: HOST, whoisPort: whois.port }
    await assert.rejects(lookupExpiry('hidden.test', 2_000, ep), /did not report an expiry date/)
    await assert.rejects(lookupExpiry('x.nowhere', 2_000, ep), /No RDAP or WHOIS server is known for \.nowhere/)
  })
})

// ── Validation ────────────────────────────────────────────────────────────────

describe('configuration of the service monitors', () => {
  const redis = { host: 'cache.test', port: 6379 }
  const mail = { protocol: 'imap', host: 'mail.test', port: 993, security: 'tls' }

  it('accepts complete configurations', () => {
    assert.equal(validateServiceConfig('redis', { ...redis, tls: true, verifyTls: false, username: 'a', password: 'b', tlsCa: 'PEM' }), null)
    assert.equal(validateServiceConfig('mail', { ...mail, username: 'me', password: 'pw' }), null)
    assert.equal(validateServiceConfig('ssh', { host: 'h.test', port: 22, expectedBanner: 'OpenSSH' }), null)
    assert.equal(validateServiceConfig('tls', { host: 'h.test', port: 443, warnDays: 14, servername: 'www.h.test' }), null)
    assert.equal(validateServiceConfig('domain', { domain: 'example.com', warnDays: 30 }), null)
  })

  it('rejects what a checker could not use', () => {
    const problems: [Parameters<typeof validateServiceConfig>[0], Record<string, unknown>, RegExp][] = [
      ['redis', { ...redis, host: '' }, /host/],
      ['redis', { ...redis, host: 'a b' }, /host/],
      ['redis', { ...redis, port: 0 }, /port/],
      ['redis', { ...redis, port: '6379' }, /port/],
      ['redis', { ...redis, port: 70_000 }, /port/],
      ['redis', { ...redis, tls: 'yes' }, /tls/],
      ['redis', { ...redis, verifyTls: 1 }, /verifyTls/],
      ['redis', { ...redis, password: 5 }, /password/],
      ['mail', { ...mail, protocol: 'ftp' }, /protocol/],
      ['mail', { ...mail, security: 'ssl' }, /security/],
      ['mail', { ...mail, tlsCa: 'x'.repeat(70_000) }, /tlsCa/],
      ['ssh', { host: 'h', port: 22, expectedBanner: 'x'.repeat(300) }, /expectedBanner/],
      ['tls', { host: 'h', port: 443 }, /warnDays/],
      ['tls', { host: 'h', port: 443, warnDays: 0 }, /warnDays/],
      ['tls', { host: 'h', port: 443, warnDays: 1000 }, /warnDays/],
      ['domain', { domain: 'localhost', warnDays: 30 }, /domain/],
      ['domain', { domain: 'example.com', warnDays: 1.5 }, /warnDays/],
    ]
    for (const [type, config, message] of problems) assert.match(validateServiceConfig(type, config) ?? '', message, `${type} ${JSON.stringify(config)}`)
  })

  it('is applied when a monitor is created', () => {
    const created = parseNewMonitor({ name: 'Cache', type: 'redis', config: redis })
    assert.ok('value' in created && created.value.type === 'redis')
    const rejected = parseNewMonitor({ name: 'Cache', type: 'redis', config: { host: 'cache.test' } })
    assert.ok('error' in rejected && /port/.test(rejected.error))
    for (const type of ['mail', 'ssh', 'tls', 'domain']) assert.ok('error' in parseNewMonitor({ name: 'X', type, config: {} }), type)
  })
})

// ── Test runner and routes ────────────────────────────────────────────────────

describe('test button for the service monitors', () => {
  it('reports success with the checker\'s detail and failure with its error', async () => {
    const redis = await track(fakeRedis())
    const ok = await testRedis({ host: HOST, port: redis.port }, 2_000)
    assert.equal(ok.overall, 'ok')
    assert.deepEqual([ok.steps[0]!.label, ok.steps[0]!.status, ok.steps[0]!.detail], [`Redis ${HOST}:${redis.port}`, 'ok', 'PING answered PONG'])

    const smtp = await track(fakeSmtp())
    assert.equal((await testMail({ protocol: 'smtp', host: HOST, port: smtp.port, security: 'none' }, 2_000)).steps[0]!.label, `SMTP ${HOST}:${smtp.port}`)

    const ssh = await track(fake({ greeting: 'SSH-2.0-X', onLine: () => {} }))
    assert.equal((await testSsh({ host: HOST, port: ssh.port }, 2_000)).overall, 'ok')

    const closed = await fake({ onLine: () => {} })
    await closed.close()
    const down = await testSsh({ host: HOST, port: closed.port }, 1_000)
    assert.equal(down.overall, 'error')
    assert.equal(down.steps[0]!.label, `SSH ${HOST}:${closed.port} failed`)
    assert.ok(down.steps[0]!.detail)
  })

  it('shows an expiring certificate as a failed step with the days left', async () => {
    const server = await track(fake({ implicitTls: true, onLine: () => {} }))
    const result = await testTlsCert({ host: HOST, port: server.port, warnDays: 365_000, verifyTls: false }, 2_000)
    assert.equal(result.overall, 'error')
    assert.match(result.steps[0]!.detail ?? '', /expires on 2126-09-24/)
  })

  it('reports an unknown domain', async () => {
    const result = await testDomain({ domain: 'not a domain', warnDays: 30 }, 1_000)
    assert.equal(result.overall, 'error')
  })
})

describe('service monitor routes', () => {
  const app = Fastify({ logger: false })
  let vaultId = 0
  before(async () => {
    initTestDb()
    vaultId = (await db.insert(vaults).values({ name: 'Primary', type: 'local', createdAt: Date.now(), updatedAt: Date.now() }).returning())[0]!.id
    app.addHook('preHandler', async (request) => {
      request.user = { userId: 1, email: 'admin@example.test', role: 'admin' }
    })
    await app.register(monitorRoutes, { prefix: '/monitors' })
    await app.ready()
  })
  after(async () => {
    await app.close()
    teardownTestDb(testDb)
  })

  it('creates a monitor of every new type', async () => {
    const bodies = [
      { name: 'Ledger', type: 'oracle', config: { host: 'db.test', port: 1521, database: 'FREEPDB1', user: 'mon', password: 'pw', query: 'SELECT 1 FROM DUAL', tls: 'verify' } },
      { name: 'Cache', type: 'redis', config: { host: 'cache.test', port: 6379, password: 'secret' } },
      { name: 'Mail', type: 'mail', config: { protocol: 'smtp', host: 'mail.test', port: 587, security: 'starttls' } },
      { name: 'Shell', type: 'ssh', config: { host: 'h.test', port: 22 } },
      { name: 'Cert', type: 'tls', config: { host: 'h.test', port: 443, warnDays: 14 } },
      { name: 'Domain', type: 'domain', config: { domain: 'example.com', warnDays: 30 }, intervalSecs: 3600 },
    ]
    for (const body of bodies) {
      const res = await app.inject({ method: 'POST', url: '/monitors', payload: body })
      assert.equal(res.statusCode, 200, `${body.type}: ${res.body}`)
      assert.equal(res.json().type, body.type)
    }
  })

  it('masks the password of a Redis or mail monitor and keeps it when the mask comes back', async () => {
    const created = (await app.inject({ method: 'POST', url: '/monitors', payload: { name: 'Secret cache', type: 'redis', config: { host: 'cache.test', port: 6379, password: 'secret' } } })).json()
    assert.equal(created.config.password, SECRET_MASK)
    const mailbox = (await app.inject({ method: 'POST', url: '/monitors', payload: { name: 'Secret mail', type: 'mail', config: { protocol: 'imap', host: 'm.test', port: 993, security: 'tls', username: 'me', password: 'pw' } } })).json()
    assert.equal(mailbox.config.password, SECRET_MASK)
    assert.equal(mailbox.config.username, 'me')

    const patched = await app.inject({ method: 'PATCH', url: `/monitors/${created.id}`, payload: { config: { ...created.config, tls: true } } })
    assert.equal(patched.statusCode, 200)
    const stored = JSON.parse((await db.select().from(monitors).where(eq(monitors.id, created.id)))[0]!.config)
    assert.deepEqual([stored.password, stored.tls], ['secret', true])

    // Pointing the monitor at another server must not send the stored password there.
    const moved = await app.inject({ method: 'PATCH', url: `/monitors/${created.id}`, payload: { config: { ...created.config, host: 'other.test' } } })
    assert.equal(moved.statusCode, 400)
  })

  it('does not keep a stored password when the connection gets less protected', async () => {
    const mail = { protocol: 'imap', host: 'm.test', port: 993, security: 'tls', username: 'me', password: 'pw' }
    const created = (await app.inject({ method: 'POST', url: '/monitors', payload: { name: 'Guarded mail', type: 'mail', config: mail } })).json()
    const patch = (config: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/monitors/${created.id}`, payload: { config: { ...created.config, ...config } } })

    for (const weaker of [{ verifyTls: false }, { tlsCa: 'PEM of my own authority' }, { security: 'none' }]) {
      const res = await patch(weaker)
      assert.equal(res.statusCode, 400, JSON.stringify(weaker))
      assert.match(res.json().error, /stored secrets cannot be kept/)
    }
    // With the password typed again, the same change is the user's decision.
    assert.equal((await patch({ security: 'none', password: 'pw' })).statusCode, 200)

    const redis = (await app.inject({ method: 'POST', url: '/monitors', payload: { name: 'Guarded cache', type: 'redis', config: { host: 'c.test', port: 6379, tls: true, password: 'pw' } } })).json()
    const off = await app.inject({ method: 'PATCH', url: `/monitors/${redis.id}`, payload: { config: { ...redis.config, tls: false } } })
    assert.equal(off.statusCode, 400)
    const stricter = await app.inject({ method: 'PATCH', url: `/monitors/${redis.id}`, payload: { config: { ...redis.config, verifyTls: true } } })
    assert.equal(stricter.statusCode, 200)
  })

  it('validates the configuration of a test like that of a saved monitor', async () => {
    for (const config of [{ host: 'h.test', port: 25 }, { protocol: 'toString', host: 'h.test', port: 25, security: 'none' }, { protocol: 'smtp', host: 'h.test', port: 25, security: 'none', tlsCa: 'x'.repeat(70_000) }]) {
      const res = await app.inject({ method: 'POST', url: '/monitors/test', payload: { type: 'mail', config } })
      assert.equal(res.statusCode, 400, JSON.stringify(config).slice(0, 80))
    }
  })

  async function secret(name: string, payload: unknown): Promise<number> {
    const [row] = await db.insert(vaultSecrets).values({ vaultId, name, type: 'userpass', encryptedValue: encrypt(JSON.stringify(payload)), createdAt: Date.now(), updatedAt: Date.now() }).returning()
    return row!.id
  }

  it('signs in with the account of a vault secret instead of typed values', async () => {
    const redis = await track(fakeRedis({ password: 'vault-pw', user: 'vault-user' }))
    const login = await secret('redis login', { username: 'vault-user', password: 'vault-pw' })
    const vault = { vaultId, secretId: login }
    const tested = await app.inject({ method: 'POST', url: '/monitors/test', payload: { type: 'redis', config: { host: HOST, port: redis.port, username: 'typed', password: 'typed', vault } } })
    assert.equal(tested.json().overall, 'ok', tested.body)

    const imap = await track(fakeImap({ user: 'vault-user', password: 'vault-pw' }))
    const mailTest = await app.inject({ method: 'POST', url: '/monitors/test', payload: { type: 'mail', config: { protocol: 'imap', host: HOST, port: imap.port, security: 'none', vault } } })
    assert.equal(mailTest.json().overall, 'ok', mailTest.body)
  })

  it('refuses to connect to a metadata address with every socket-based type', async () => {
    const target = { host: '169.254.169.254', port: 1 }
    const results = [
      await checkRedis(target, 1_000),
      await checkMail({ ...target, protocol: 'smtp', security: 'none' }, 1_000),
      await checkSsh(target, 1_000),
      await checkTlsCert({ ...target, warnDays: 14 }, 1_000),
    ]
    for (const result of results) assert.match(result.error ?? '', /Refusing to connect/)
  })

  it('runs the scheduled check of every socket-based type', async () => {
    const redis = await track(fakeRedis())
    const smtp = await track(fakeSmtp())
    const certificate = await track(fake({ implicitTls: true, onLine: () => {} }))
    const cases = [
      { name: 'Sched cache', type: 'redis', config: { host: HOST, port: redis.port } },
      { name: 'Sched mail', type: 'mail', config: { protocol: 'smtp', host: HOST, port: smtp.port, security: 'none' } },
      { name: 'Sched cert', type: 'tls', config: { host: HOST, port: certificate.port, warnDays: 14, verifyTls: false } },
      { name: 'Sched unreachable', type: 'redis', config: { host: HOST, port: 1 } },
    ]
    const status: string[] = []
    for (const body of cases) {
      const created = (await app.inject({ method: 'POST', url: '/monitors', payload: body })).json()
      status.push((await app.inject({ method: 'POST', url: `/monitors/${created.id}/check-now` })).json().currentStatus)
    }
    assert.deepEqual(status, ['up', 'up', 'up', 'down'])
  })

  it('rejects an invalid configuration', async () => {
    const res = await app.inject({ method: 'POST', url: '/monitors', payload: { name: 'Bad', type: 'tls', config: { host: 'h.test', port: 443 } } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error, /warnDays/)
  })

  it('tests each type through /test and runs the scheduled check through check-now', async () => {
    const redis = await track(fakeRedis())
    const tested = await app.inject({ method: 'POST', url: '/monitors/test', payload: { type: 'redis', config: { host: HOST, port: redis.port } } })
    assert.equal(tested.statusCode, 200)
    assert.equal(tested.json().overall, 'ok')

    const smtp = await track(fakeSmtp())
    const mail = await app.inject({ method: 'POST', url: '/monitors/test', payload: { type: 'mail', config: { protocol: 'smtp', host: HOST, port: smtp.port, security: 'none' } } })
    assert.equal(mail.json().overall, 'ok')

    const ssh = await track(fake({ greeting: 'SSH-2.0-X', onLine: () => {} }))
    const created = (await app.inject({ method: 'POST', url: '/monitors', payload: { name: 'Live shell', type: 'ssh', config: { host: HOST, port: ssh.port } } })).json()
    const checked = (await app.inject({ method: 'POST', url: `/monitors/${created.id}/check-now` })).json()
    assert.equal(checked.currentStatus, 'up')

    const tlsServer = await track(fake({ implicitTls: true, onLine: () => {} }))
    const cert = await app.inject({ method: 'POST', url: '/monitors/test', payload: { type: 'tls', config: { host: HOST, port: tlsServer.port, warnDays: 14, verifyTls: false } } })
    assert.equal(cert.json().overall, 'ok')
  })
})
