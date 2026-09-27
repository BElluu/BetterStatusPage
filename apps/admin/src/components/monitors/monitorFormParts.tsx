import type { ReactNode } from 'react'

// Building blocks shared by the monitor form and its extracted sections.

export interface VaultSummary  { id: number; name: string }
export interface SecretSummary { id: number; name: string; type: 'userpass' | 'value' | 'json' }

/** What every vault-aware credential picker needs to list vaults and lazily load their secrets. */
export interface VaultPickerProps {
  vaults: { id: number; name: string }[]
  secretsByVault: Record<number, { id: number; name: string; type: string }[]>
  onLoadSecrets: (vaultId: number) => Promise<void>
}

// Fields that can be sourced from a json vault secret, per context
export const JSON_MAPPING_FIELDS: Record<'basic' | 'oauth2' | 'cas' | 'sqlserver', { key: string; label: string }[]> = {
  basic:     [{ key: 'username', label: 'Username' }, { key: 'password', label: 'Password' }],
  oauth2:    [{ key: 'clientId', label: 'Client ID' }, { key: 'clientSecret', label: 'Client Secret' }],
  cas:       [{ key: 'username', label: 'Username' }, { key: 'password', label: 'Password' }],
  sqlserver: [{ key: 'username', label: 'Username' }, { key: 'password', label: 'Password' }],
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
        {label}
      </label>
      {children}
    </div>
  )
}

export function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <div style={{ flex: 1, borderTop: '1px solid var(--m3-outline-variant)' }} />
      <span className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>{label}</span>
      <div style={{ flex: 1, borderTop: '1px solid var(--m3-outline-variant)' }} />
    </div>
  )
}

/** Tinted callout: `info` uses the accent blue, `warning` the degraded amber. */
export function Note({ tone, children }: { tone: 'info' | 'warning'; children: ReactNode }) {
  const color = tone === 'info' ? 'var(--m3-on-primary-container)' : 'var(--m3-degraded-bar)'
  return (
    <div
      className="flex items-start gap-2 rounded-lg px-3 py-2"
      style={{ background: `color-mix(in srgb, ${color} 8%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 20%, transparent)` }}
    >
      {tone === 'info'
        ? <span className="material-symbols-outlined" style={{ fontSize: '16px', color, lineHeight: '20px' }}>info</span>
        : <span style={{ color, lineHeight: '20px' }}>⚠</span>}
      <p className="text-xs" style={{ color: 'var(--m3-on-surface-variant)' }}>{children}</p>
    </div>
  )
}

/** Adds or removes one id from a selection set without mutating it. */
export function toggleInSet(set: Set<number>, id: number, on: boolean): Set<number> {
  const next = new Set(set)
  if (on) next.add(id)
  else next.delete(id)
  return next
}
