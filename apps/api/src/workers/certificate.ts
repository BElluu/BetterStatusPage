import { connect } from 'tls'
import { isIP } from 'net'
import { eq } from 'drizzle-orm'
import { CERT_REMINDER_DAYS, DEFAULT_CERT_WARN_DAYS, MAX_CERT_WARN_DAYS } from '@bsp/shared'
import type { CertExpiryConfig, HttpsConfig } from '@bsp/shared'
import { db } from '../db/client.js'
import { monitors } from '../db/schema.js'
import { sendCertificateNotifications } from './notifier.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** Certificates change rarely — one extra handshake every few hours per monitor is plenty. */
export const CERT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** A failed read is retried sooner than a successful one is refreshed, but not on every check. */
export const CERT_RETRY_INTERVAL_MS = 15 * 60 * 1000

type MonitorRow = typeof monitors.$inferSelect

export interface CertificateInfo {
  host: string
  expiresAt: number
  issuer: string
}

export type CertificateReader = (url: string, timeoutMs: number) => Promise<CertificateInfo>

/** Where the certificate is read from, or null for a URL that does not use TLS. */
export function certificateTarget(url: string): { host: string; port: number } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  return { host: parsed.hostname.replace(/^\[(.*)\]$/, '$1'), port: parsed.port ? Number(parsed.port) : 443 }
}

function commonName(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : value ?? ''
}

/**
 * Reads the certificate the endpoint presents, over its own short-lived connection: the scheduled
 * check reuses pooled connections, so it never sees a handshake it could take the certificate from.
 */
export const readCertificate: CertificateReader = (url, timeoutMs) => {
  const target = certificateTarget(url)
  if (!target) return Promise.reject(new Error(`Not an HTTPS URL: ${url}`))
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: target.host,
      port: target.port,
      // SNI must name a host, never an IP address.
      ...(isIP(target.host) ? {} : { servername: target.host }),
      // Only the dates are read here. Whether the certificate is trusted is the scheduled check's
      // call, and a certificate it rejects should still show when it expires.
      rejectUnauthorized: false,
      timeout: timeoutMs,
    })
    const finish = (settle: () => void) => {
      socket.destroy()
      settle()
    }
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      const expiresAt = Date.parse(cert?.valid_to ?? '')
      if (!Number.isFinite(expiresAt)) {
        finish(() => reject(new Error('Endpoint presented no TLS certificate')))
        return
      }
      finish(() => resolve({ host: target.host, expiresAt, issuer: commonName(cert.issuer?.CN) }))
    })
    socket.once('timeout', () => finish(() => reject(new Error(`TLS handshake timed out after ${timeoutMs} ms`))))
    socket.once('error', (err) => finish(() => reject(err)))
  })
}

/** The expiry warning settings in effect, or null when warnings are off. */
export function normalizeCertExpiry(config: Partial<CertExpiryConfig> | undefined): CertExpiryConfig | null {
  if (!config?.enabled) return null
  const days = Number(config.warnDays)
  const warnDays = Number.isFinite(days) ? Math.min(MAX_CERT_WARN_DAYS, Math.max(1, Math.round(days))) : DEFAULT_CERT_WARN_DAYS
  return { enabled: true, warnDays }
}

/**
 * The smallest warning milestone (days before expiry) that `daysLeft` has reached: the configured
 * lead time first, then the fixed reminders below it. Null while the expiry is further away.
 */
export function certMilestone(daysLeft: number, warnDays: number): number | null {
  const reached = [warnDays, ...CERT_REMINDER_DAYS.filter((days) => days < warnDays)].filter((days) => daysLeft <= days)
  return reached.length > 0 ? Math.min(...reached) : null
}

/**
 * Refreshes the certificate expiry of an HTTPS monitor and warns once per milestone as it nears.
 * The monitor's status is left alone — a certificate that expires next week is not an outage, and
 * one that has already expired fails the scheduled check, which alerts on its own.
 */
export async function checkCertificateExpiry(
  monitor: MonitorRow,
  config: HttpsConfig,
  now = Date.now(),
  read: CertificateReader = readCertificate,
): Promise<void> {
  if (!certificateTarget(config.url)) return
  if (monitor.certCheckedAt !== null && monitor.certCheckedAt + CERT_CHECK_INTERVAL_MS > now) return

  let cert: CertificateInfo
  try {
    cert = await read(config.url, monitor.timeoutMs)
  } catch (err) {
    // Keep the last known expiry; the endpoint being unreachable is reported by the check itself.
    await db.update(monitors).set({ certCheckedAt: now - CERT_CHECK_INTERVAL_MS + CERT_RETRY_INTERVAL_MS })
      .where(eq(monitors.id, monitor.id))
    console.warn(`[certificate] Could not read the certificate of monitor ${monitor.id}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const policy = normalizeCertExpiry(config.certExpiry)
  // A later expiry means a new certificate: its milestones start over.
  const renewed = monitor.certExpiresAt !== null && cert.expiresAt > monitor.certExpiresAt
  const previouslyWarned = renewed ? null : monitor.certWarnedDays
  const daysLeft = (cert.expiresAt - now) / DAY_MS
  const milestone = policy && daysLeft > 0 ? certMilestone(daysLeft, policy.warnDays) : null
  const warn = milestone !== null && (previouslyWarned === null || milestone < previouslyWarned)

  await db.update(monitors).set({
    certExpiresAt: cert.expiresAt,
    certCheckedAt: now,
    certWarnedDays: warn ? milestone : previouslyWarned,
  }).where(eq(monitors.id, monitor.id))

  const event = { host: cert.host, expiresAt: cert.expiresAt, daysLeft }
  // Only a certificate someone was warned about owes an all-clear.
  if (policy && renewed && monitor.certWarnedDays !== null) await sendCertificateNotifications(monitor, { ...event, kind: 'renewed' })
  if (warn) await sendCertificateNotifications(monitor, { ...event, kind: 'expiring' })
}
