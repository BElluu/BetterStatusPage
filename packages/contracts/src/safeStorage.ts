/** Browser storage that never throws: a blocked or full storage reads as empty and drops writes. */
export interface SafeStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

function safe(area: () => Storage): SafeStorage {
  return {
    get(key) { try { return area().getItem(key) } catch { return null } },
    set(key, value) { try { area().setItem(key, value) } catch { /* storage unavailable: the value lasts for this page only */ } },
    remove(key) { try { area().removeItem(key) } catch { /* storage unavailable: nothing to remove */ } },
  }
}

export const safeLocalStorage = safe(() => localStorage)
export const safeSessionStorage = safe(() => sessionStorage)
