import { guardedFetch } from '../services/ssrfGuard.js'
import { errorText, failed, open, type CheckOutcome } from './probe.js'
import { expiryOutcome } from './tlsCert.js'
import type { DomainConfig } from '@bsp/shared'
import { normalizeDomain } from './domainName.js'

export { normalizeDomain } from './domainName.js'

/** Where the registries are asked; a parameter so a test can point it at servers of its own. */
export interface RegistryEndpoints { bootstrapUrl: string; ianaWhoisHost: string; whoisPort: number }
const IANA: RegistryEndpoints = { bootstrapUrl: 'https://data.iana.org/rdap/dns.json', ianaWhoisHost: 'whois.iana.org', whoisPort: 43 }
/** A registration changes rarely, and registries rate-limit: one lookup per domain every few hours is plenty. */
const EXPIRY_CACHE_MS = 6 * 60 * 60 * 1000
const BOOTSTRAP_CACHE_MS = 24 * 60 * 60 * 1000
const MAX_WHOIS_LINES = 500
/** A lookup that failed is not repeated for this long, so a registry that refuses us is not asked every interval. */
const FAILURE_CACHE_MS = 30 * 60 * 1000
const MAX_CACHED_DOMAINS = 1000

// ── RDAP ──────────────────────────────────────────────────────────────────────

interface RdapBootstrap { services: [string[], string[]][] }

/** The RDAP server of `tld` according to the IANA bootstrap file, or null when the registry has none. */
export function rdapBase(bootstrap: RdapBootstrap, tld: string): string | null {
  const service = bootstrap.services.find(([tlds]) => tlds.includes(tld))
  const url = service?.[1].find((u) => u.startsWith('https://')) ?? service?.[1][0]
  return url ? url.replace(/\/?$/, '/') : null
}

/** The `expiration` event of an RDAP domain answer, as epoch milliseconds. */
export function parseRdapExpiry(answer: unknown): number | null {
  const events = (answer as { events?: { eventAction?: string; eventDate?: string }[] } | null)?.events
  const date = events?.find((e) => e.eventAction === 'expiration')?.eventDate
  const time = Date.parse(date ?? '')
  return Number.isFinite(time) ? time : null
}

// ── WHOIS ─────────────────────────────────────────────────────────────────────

const WHOIS_EXPIRY_LINE = /^\s*(?:registry expiry date|registrar registration expiration date|expiry date|expiration date|expires(?: on)?|paid-till|renewal date)\s*[:.]*\s*(.+)$/im
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Reads a date the way registries write it: 2026-12-22T10:00:00Z, 2026.12.22 13:00:00, 22-Dec-2026. Times are UTC. */
export function parseWhoisDate(text: string): number | null {
  const iso = /(\d{4})[-./](\d{2})[-./](\d{2})(?:[T\s]+(\d{2}):(\d{2}):(\d{2}))?/.exec(text)
  if (iso) return Date.UTC(+iso[1]!, +iso[2]! - 1, +iso[3]!, +(iso[4] ?? 0), +(iso[5] ?? 0), +(iso[6] ?? 0))
  const named = /(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{4})/.exec(text)
  const month = named ? MONTHS.indexOf(named[2]!.toLowerCase()) : -1
  return named && month >= 0 ? Date.UTC(+named[3]!, month, +named[1]!) : null
}

export function parseWhoisExpiry(response: string): number | null {
  const line = WHOIS_EXPIRY_LINE.exec(response)
  return line ? parseWhoisDate(line[1]!) : null
}

async function whoisQuery(server: string, query: string, timeoutMs: number, port: number): Promise<string> {
  const c = await open({ host: server, port, tls: false, timeoutMs })
  try {
    c.send(query)
    const lines: string[] = []
    try {
      while (lines.length < MAX_WHOIS_LINES) lines.push(await c.readLine())
    } catch (err) {
      // The server ends the answer by closing (or resetting, or going quiet); what it said before is the answer.
      if (lines.length === 0) throw err
    }
    return lines.join('\n')
  } finally {
    c.close()
  }
}

const whoisServers = new Map<string, string>()

async function whoisExpiry(domain: string, tld: string, timeoutMs: number, ep: RegistryEndpoints): Promise<number> {
  let server = whoisServers.get(tld)
  if (!server) {
    server = /^\s*whois:\s*(\S+)/im.exec(await whoisQuery(ep.ianaWhoisHost, tld, timeoutMs, ep.whoisPort))?.[1]
    if (!server) throw new Error(`No RDAP or WHOIS server is known for .${tld}`)
    whoisServers.set(tld, server)
  }
  const expiresAt = parseWhoisExpiry(await whoisQuery(server, domain, timeoutMs, ep.whoisPort))
  if (expiresAt === null) throw new Error(`The WHOIS server ${server} did not report an expiry date for ${domain}`)
  return expiresAt
}

// ── Lookup ────────────────────────────────────────────────────────────────────

let bootstrapCache: { fetchedAt: number; value: RdapBootstrap } | null = null

async function bootstrap(timeoutMs: number, now: number, url: string): Promise<RdapBootstrap> {
  if (bootstrapCache && now - bootstrapCache.fetchedAt < BOOTSTRAP_CACHE_MS) return bootstrapCache.value
  const res = await guardedFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`The IANA RDAP bootstrap answered ${res.status}`)
  const value = await res.json() as RdapBootstrap
  bootstrapCache = { fetchedAt: now, value }
  return value
}

/** `timeoutMs` bounds the whole lookup, not each request in it. */
export type ExpiryLookup = (domain: string, timeoutMs: number, endpoints?: RegistryEndpoints) => Promise<number>

/** When the registration of `domain` ends (epoch milliseconds): RDAP where the registry offers it, WHOIS otherwise. */
export const lookupExpiry: ExpiryLookup = async (domain, timeoutMs, ep = IANA) => {
  const deadline = Date.now() + timeoutMs
  const left = () => Math.max(1, deadline - Date.now())
  const tld = domain.slice(domain.lastIndexOf('.') + 1)
  const base = rdapBase(await bootstrap(left(), Date.now(), ep.bootstrapUrl), tld)
  if (!base) return whoisExpiry(domain, tld, left(), ep)
  const res = await guardedFetch(`${base}domain/${encodeURIComponent(domain)}`, {
    headers: { accept: 'application/rdap+json' },
    signal: AbortSignal.timeout(left()),
  })
  if (res.status === 404) throw new Error(`${domain} is not registered`)
  if (!res.ok) throw new Error(`The RDAP server answered ${res.status}`)
  const expiresAt = parseRdapExpiry(await res.json())
  if (expiresAt === null) throw new Error(`The RDAP answer for ${domain} has no expiration date`)
  return expiresAt
}

type Lookup = { at: number } & ({ expiresAt: number } | { error: string })
const lookedUp = new Map<string, Lookup>()

/** Judges the registration of a domain: Down once it has expired, Degraded inside the warning window. */
export async function checkDomainExpiry(
  config: DomainConfig,
  timeoutMs: number,
  { now = Date.now(), lookup = lookupExpiry }: { now?: number; lookup?: ExpiryLookup } = {},
): Promise<CheckOutcome> {
  const start = Date.now()
  try {
    const domain = normalizeDomain(config.domain)
    if (!domain) throw new Error(`"${config.domain}" is not a domain name`)
    let cached = lookedUp.get(domain)
    if (!cached || now - cached.at >= ('error' in cached ? FAILURE_CACHE_MS : EXPIRY_CACHE_MS)) {
      try {
        cached = { at: now, expiresAt: await lookup(domain, timeoutMs) }
      } catch (err) {
        cached = { at: now, error: errorText(err) }
      }
      // Entries are never read again once their monitor is gone, so the oldest make room.
      if (lookedUp.size >= MAX_CACHED_DOMAINS) lookedUp.delete(lookedUp.keys().next().value!)
      lookedUp.set(domain, cached)
    }
    if ('error' in cached) throw new Error(cached.error)
    return { responseMs: Date.now() - start, ...expiryOutcome(`Domain ${domain}`, cached.expiresAt, config.warnDays, now) }
  } catch (err) {
    return failed(err, start)
  }
}

/** For tests: forget what was looked up. */
export function clearDomainCache(): void {
  lookedUp.clear()
  whoisServers.clear()
  bootstrapCache = null
}
