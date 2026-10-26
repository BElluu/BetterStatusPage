import { isIPv6 } from 'node:net'

/**
 * The key a client is rate limited under. An IPv4 address is its own key; an IPv6 address is
 * reduced to its /64, because one subscriber is routinely handed a whole /64 and could otherwise
 * rotate through billions of addresses to dodge a per-address limit.
 */
export function rateLimitKey(ip: string): string {
  const address = ip.split('%')[0] ?? ip
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return mapped[1]!
  if (!isIPv6(address)) return address

  const [head = '', tail] = address.split('::')
  const front = head ? head.split(':') : []
  const back = tail ? tail.split(':') : []
  const groups = tail === undefined ? front : [...front, ...Array<string>(8 - front.length - back.length).fill('0'), ...back]
  const prefix = groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16))
  return `${prefix.join(':')}::/64`
}
