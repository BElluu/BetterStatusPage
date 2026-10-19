import { sha256Hex } from './sigv4.js'

export interface MirrorObject {
  /** Path below the target's root, without a leading slash. */
  key: string
  body: string | Uint8Array
  contentType: string
  cacheControl?: string
}

export interface MirrorTransport {
  put(object: MirrorObject, signal?: AbortSignal): Promise<void>
  delete(key: string, signal?: AbortSignal): Promise<void>
}

export interface PublishResult {
  uploaded: string[]
  unchanged: number
}

export interface MirrorPublisherOptions {
  transport: MirrorTransport
  /** Per request, in milliseconds. */
  timeoutMs?: number
}

/**
 * Uploads objects in the order given, so a page that refers to other files goes after them. An object whose content
 * is the same as at its last successful upload is skipped. The first failure stops the run: whatever was not
 * uploaded is retried by the next one.
 */
export function createMirrorPublisher({ transport, timeoutMs = 30_000 }: MirrorPublisherOptions) {
  const uploadedHashes = new Map<string, string>()

  return {
    async publish(objects: MirrorObject[]): Promise<PublishResult> {
      const uploaded: string[] = []
      let unchanged = 0
      for (const object of objects) {
        const hash = sha256Hex(object.body)
        if (uploadedHashes.get(object.key) === hash) {
          unchanged++
          continue
        }
        await transport.put(object, AbortSignal.timeout(timeoutMs))
        uploadedHashes.set(object.key, hash)
        uploaded.push(object.key)
      }
      return { uploaded, unchanged }
    },
    /** Forget what was uploaded, so the next run uploads everything. */
    reset() {
      uploadedHashes.clear()
    },
  }
}
