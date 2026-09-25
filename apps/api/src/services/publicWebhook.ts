import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Agent, fetch as httpFetch } from 'undici'

/**
 * Subscriber webhooks are URLs typed in by anonymous visitors, so the server must not become a
 * proxy into its own network. Addresses are checked at connect time (not only when the URL is
 * saved), which also defeats DNS rebinding between validation and delivery.
 */
const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(network, prefix, 'ipv6')

/** Self-hosted intranet status pages may legitimately notify internal systems. */
export function privateWebhookTargetsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUBSCRIBER_WEBHOOK_ALLOW_PRIVATE'] === 'true'
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  // BlockList checks IPv4-mapped IPv6 addresses against the IPv4 rules.
  return !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4')
}

const guardedLookup: LookupFunction = (hostname, options, callback): void => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, [])
    const refused = addresses.find((entry) => !isPublicAddress(entry.address))
    if (refused || addresses.length === 0) {
      const reason = refused ? `non-public address ${refused.address}` : 'no address'
      return callback(Object.assign(new Error(`Refusing webhook to ${hostname}: ${reason}`), { code: 'EBLOCKED' }), [])
    }
    if (options.all) callback(null, addresses)
    else callback(null, addresses[0]!.address, addresses[0]!.family)
  })
}

const guardedAgent = new Agent({ connect: { lookup: guardedLookup } })
const openAgent = new Agent()

/** Syntactic check used when a visitor submits a URL. Returns an error message or null. */
export function validateWebhookUrl(raw: string): string | null {
  if (raw.length > 2048) return 'Webhook URL is too long'
  let url: URL
  try { url = new URL(raw) } catch { return 'Webhook URL is not a valid URL' }
  const allowPrivate = privateWebhookTargetsAllowed()
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) return 'Webhook URL must use https'
  if (url.username || url.password) return 'Webhook URL must not contain credentials'
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
      return 'Webhook URL must point to a public host'
    }
    if (isIP(host) && !isPublicAddress(host)) return 'Webhook URL must point to a public host'
  }
  return null
}

export async function postSubscriberWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
  method: 'POST' | 'PUT' | 'PATCH' = 'POST',
): Promise<void> {
  const problem = validateWebhookUrl(url)
  if (problem) throw new Error(problem)
  const res = await httpFetch(url, {
    method,
    // Caller-supplied headers go first so the ones the payload contract depends on always win.
    headers: { ...headers, 'Content-Type': 'application/json', 'User-Agent': 'BetterStatusPage-Subscriptions' },
    body,
    // A redirect to an IP literal would skip the DNS guard, so redirects are never followed.
    redirect: 'error',
    dispatcher: privateWebhookTargetsAllowed() ? openAgent : guardedAgent,
    signal: AbortSignal.timeout(10_000),
  })
  await res.body?.cancel().catch(() => undefined)
  if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}`)
}
