/**
 * Keeps the answer to a request for a few seconds, so a burst of identical requests runs its query once. The pending
 * promise is what is kept, so requests that arrive while it is still loading share it. A failed load is not kept.
 * When full it drops the entries that have expired, and everything if none had.
 */
export function createTtlCache<T>(ttlMs: number, maxEntries: number) {
  const entries = new Map<string, { expiresAt: number; value: Promise<T> }>()
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const now = Date.now()
      const cached = entries.get(key)
      if (cached && cached.expiresAt > now) return cached.value

      if (entries.size >= maxEntries) {
        for (const [entryKey, entry] of entries) if (entry.expiresAt <= now) entries.delete(entryKey)
        if (entries.size >= maxEntries) entries.clear()
      }
      const value = load()
      entries.set(key, { expiresAt: now + ttlMs, value })
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key)
      })
      return value
    },
    clear(): void {
      entries.clear()
    },
  }
}
