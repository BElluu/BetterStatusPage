import { sha256Hex, signRequest } from './sigv4.js'
import type { MirrorObject, MirrorTransport } from './publisher.js'

export interface S3Options {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Base URL of an S3-compatible service (R2, B2, MinIO); leave out for AWS S3. */
  endpoint?: string
  /** Prepended to every key, e.g. `status/`. */
  prefix?: string
  /** `https://host/bucket/key` instead of `https://bucket.host/key`. Always on when an endpoint is given. */
  forcePathStyle?: boolean
}

/** Only the service's error code reaches a message, never its body, which may echo request details. */
const errorCode = (body: string): string => /<Code>([A-Za-z0-9]+)<\/Code>/.exec(body)?.[1] ?? ''

export function createS3Transport(options: S3Options): MirrorTransport {
  const prefix = (options.prefix ?? '').replace(/^\/+/, '')

  function urlFor(key: string): URL {
    const objectKey = prefix + key
    if (options.endpoint) return new URL(`${options.endpoint.replace(/\/+$/, '')}/${options.bucket}/${objectKey}`)
    // A dot in the bucket name breaks the TLS name of the virtual-host form.
    return options.forcePathStyle || options.bucket.includes('.')
      ? new URL(`https://s3.${options.region}.amazonaws.com/${options.bucket}/${objectKey}`)
      : new URL(`https://${options.bucket}.s3.${options.region}.amazonaws.com/${objectKey}`)
  }

  async function send(
    method: 'PUT' | 'DELETE', key: string, body: Buffer<ArrayBuffer>, contentType: string | null, cacheControl: string | undefined, signal?: AbortSignal,
  ) {
    const url = urlFor(key)
    const headers = signRequest({
      method,
      url,
      headers: contentType ? { 'content-type': contentType } : {},
      payloadHash: sha256Hex(body),
      region: options.region,
      service: 's3',
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      now: new Date(),
    })
    // Sent unsigned, as the service allows.
    if (cacheControl) headers['cache-control'] = cacheControl
    // fetch sets `host` from the URL.
    delete headers['host']

    // A redirect is never followed: it would send the body to a host nobody configured.
    const res = await fetch(url, { method, headers, ...(method === 'PUT' ? { body } : {}), redirect: 'manual', ...(signal ? { signal } : {}) })
    if (!res.ok) {
      const code = errorCode(await res.text().catch(() => ''))
      throw new Error(`${method === 'PUT' ? 'Upload of' : 'Removal of'} ${key} failed: HTTP ${res.status}${code ? ` ${code}` : ''}`)
    }
  }

  return {
    put: (object: MirrorObject, signal?: AbortSignal) => send('PUT', object.key, Buffer.from(object.body), object.contentType, object.cacheControl, signal),
    delete: (key: string, signal?: AbortSignal) => send('DELETE', key, Buffer.alloc(0), null, undefined, signal),
  }
}
