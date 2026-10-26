import type { MailConfig } from '@bsp/shared'
import { assertLineSafe, failed, resolveLogin, withConversation, type CheckOutcome, type Conversation } from './probe.js'

type Login = { username: string; password: string }

const CLIENT_NAME = 'betterstatuspage.local'
/** A reply with this many lines is a misbehaving server, not a long capability list. */
const MAX_REPLY_LINES = 100

function fail(step: string, line: string): never {
  throw new Error(`${step}: ${line.slice(0, 200)}`)
}

// ── SMTP ──────────────────────────────────────────────────────────────────────

/** One SMTP reply; `250-` lines continue it, `250 ` ends it. */
async function smtpReply(c: Conversation, step: string, expected: string): Promise<string[]> {
  const lines: string[] = []
  for (let i = 0; i < MAX_REPLY_LINES; i++) {
    const line = await c.readLine()
    lines.push(line)
    if (line[3] !== '-') {
      if (!line.startsWith(expected)) fail(step, line)
      return lines
    }
  }
  throw new Error(`${step}: the reply never ended`)
}

async function smtpSession(c: Conversation, config: MailConfig, login: Login): Promise<string> {
  const greeting = (await smtpReply(c, 'Greeting', '220'))[0]!
  const hello = async () => {
    c.send(`EHLO ${CLIENT_NAME}`)
    return smtpReply(c, 'EHLO', '250')
  }
  let capabilities = await hello()
  if (config.security === 'starttls') {
    if (!capabilities.some((l) => /\bSTARTTLS\b/i.test(l))) throw new Error('The server does not offer STARTTLS')
    c.send('STARTTLS')
    await smtpReply(c, 'STARTTLS', '220')
    await c.upgrade()
    capabilities = await hello()
  }
  if (login.username) {
    if (!capabilities.some((l) => /\bAUTH\b.*\bPLAIN\b/i.test(l))) throw new Error('The server does not offer AUTH PLAIN (encrypt the connection first?)')
    c.send(`AUTH PLAIN ${Buffer.from(`\0${login.username}\0${login.password}`).toString('base64')}`)
    await smtpReply(c, 'Sign-in', '235')
  }
  c.send('QUIT')
  return greeting
}

// ── IMAP ──────────────────────────────────────────────────────────────────────

/** Skips untagged lines and returns the completion line of the command `tag`. */
async function imapDone(c: Conversation, tag: string, step: string): Promise<void> {
  for (let i = 0; i < MAX_REPLY_LINES; i++) {
    const line = await c.readLine()
    if (!line.startsWith(`${tag} `)) continue
    if (!line.startsWith(`${tag} OK`)) fail(step, line)
    return
  }
  throw new Error(`${step}: the reply never ended`)
}

const imapQuote = (value: string): string => `"${value.replace(/[\\"]/g, '\\$&')}"`

async function imapSession(c: Conversation, config: MailConfig, login: Login): Promise<string> {
  const greeting = await c.readLine()
  if (!/^\* (OK|PREAUTH)\b/.test(greeting)) fail('Greeting', greeting)
  if (config.security === 'starttls') {
    c.send('a1 STARTTLS')
    await imapDone(c, 'a1', 'STARTTLS')
    await c.upgrade()
  }
  if (login.username) {
    assertLineSafe('User name', login.username)
    assertLineSafe('Password', login.password)
    c.send(`a2 LOGIN ${imapQuote(login.username)} ${imapQuote(login.password)}`)
    await imapDone(c, 'a2', 'Sign-in')
  }
  c.send('a3 LOGOUT')
  return greeting
}

// ── POP3 ──────────────────────────────────────────────────────────────────────

async function pop3Reply(c: Conversation, step: string): Promise<string> {
  const line = await c.readLine()
  if (!line.startsWith('+OK')) fail(step, line)
  return line
}

async function pop3Session(c: Conversation, config: MailConfig, login: Login): Promise<string> {
  const greeting = await pop3Reply(c, 'Greeting')
  if (config.security === 'starttls') {
    c.send('STLS')
    await pop3Reply(c, 'STLS')
    await c.upgrade()
  }
  if (login.username) {
    assertLineSafe('User name', login.username)
    assertLineSafe('Password', login.password)
    c.send(`USER ${login.username}`)
    await pop3Reply(c, 'User name')
    c.send(`PASS ${login.password}`)
    await pop3Reply(c, 'Sign-in')
  }
  c.send('QUIT')
  return greeting
}

const sessions = { smtp: smtpSession, imap: imapSession, pop3: pop3Session } satisfies Record<MailConfig['protocol'], unknown>

/** Greets the mail server, upgrades to TLS when asked and signs in when an account is configured. */
export async function checkMail(config: MailConfig, timeoutMs: number): Promise<CheckOutcome> {
  const start = Date.now()
  try {
    const login = await resolveLogin(config)
    return await withConversation({ ...config, tls: config.security === 'tls', timeoutMs }, async (c) => {
      const greeting = await sessions[config.protocol](c, config, login)
      const detail = `${greeting.slice(0, 120)}${login.username ? ' · signed in' : ''}`
      return { status: 'up', responseMs: Date.now() - start, error: null, detail } satisfies CheckOutcome
    })
  } catch (err) {
    return failed(err, start)
  }
}
