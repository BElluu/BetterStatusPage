import type { TlsCertConfig } from '@bsp/shared'
import { failed, withConversation, type CheckOutcome } from './probe.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** How a certificate that expires at `expiresAt` reads at `now`: Down once expired, Degraded inside the warning window. */
export function expiryOutcome(subject: string, expiresAt: number, warnDays: number, now: number): Pick<CheckOutcome, 'status' | 'error' | 'detail'> {
  const date = new Date(expiresAt).toISOString().slice(0, 10)
  const daysLeft = Math.floor((expiresAt - now) / DAY_MS)
  if (expiresAt <= now) return { status: 'down', error: `${subject} expired on ${date}` }
  const detail = `${subject} expires on ${date} (in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'})`
  if (daysLeft < warnDays) return { status: 'degraded', error: detail }
  return { status: 'up', error: null, detail }
}

const commonName = (value: string | string[] | undefined): string => (Array.isArray(value) ? value.join(', ') : value ?? '')

/**
 * Connects over TLS and judges the certificate the server presents: trusted and matching the host name
 * (unless `verifyTls` is off), and not expiring within `warnDays`. Works for any TLS service, not only HTTPS.
 */
export async function checkTlsCert(config: TlsCertConfig, timeoutMs: number, now = Date.now()): Promise<CheckOutcome> {
  const start = Date.now()
  try {
    return await withConversation({ ...config, tls: true, timeoutMs }, async (c) => {
      const cert = c.tls()!.getPeerCertificate()
      const expiresAt = Date.parse(cert?.valid_to ?? '')
      if (!Number.isFinite(expiresAt)) throw new Error('The server did not present a certificate')
      const subject = `Certificate for ${commonName(cert.subject?.CN) || config.servername || config.host} (issued by ${commonName(cert.issuer?.CN) || 'unknown'})`
      return { responseMs: Date.now() - start, ...expiryOutcome(subject, expiresAt, config.warnDays, now) }
    })
  } catch (err) {
    return failed(err, start)
  }
}
