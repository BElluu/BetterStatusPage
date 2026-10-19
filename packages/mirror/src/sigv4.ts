import { createHash, createHmac } from 'node:crypto'

export interface SignInput {
  method: string
  url: URL
  /** Headers to sign besides `host`, `x-amz-content-sha256` and `x-amz-date`, which are added. */
  headers: Record<string, string>
  payloadHash: string
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  now: Date
}

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest()

/** RFC 3986 encoding of one path segment, which is how S3 canonicalises object keys. */
const encodeSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** The headers of a SigV4-signed request: everything the caller passes, plus the signature headers. */
export function signRequest(input: SignInput): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[-:]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
  }
  const byName = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim()]))
  const names = [...byName.keys()].sort()
  const canonicalHeaders = names.map((name) => `${name}:${byName.get(name)}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalUri = input.url.pathname.split('/').map((s) => encodeSegment(decodeURIComponent(s))).join('/')
  const canonicalQuery = [...input.url.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeSegment(k)}=${encodeSegment(v)}`).join('&')
  const canonicalRequest = [input.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, input.payloadHash].join('\n')

  const scope = `${day}/${input.region}/${input.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}
