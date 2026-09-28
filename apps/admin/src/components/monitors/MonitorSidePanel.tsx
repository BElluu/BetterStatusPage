import type { ReactNode } from 'react'
import type { NotificationChannel } from '@bsp/shared'
import type { SidePanelMeta } from '../SidePanel'
import { Note, toggleInSet } from './monitorFormParts'

export type SidePanelKey = 'request' | 'auth' | 'tags' | 'channels' | 'dependencies'

export const PANEL_META: Record<SidePanelKey, SidePanelMeta> = {
  auth:         { icon: 'lock',          label: 'Auth' },
  request:      { icon: 'tune',          label: 'Request' },
  tags:         { icon: 'label',         label: 'Tags' },
  channels:     { icon: 'notifications', label: 'Alerts' },
  dependencies: { icon: 'account_tree',  label: 'Depends on' },
}

// ── Request (headers & body) ──────────────────────────────────────────────────

export function RequestSection({ config, updateConfig }: { config: Record<string, unknown>; updateConfig: (key: string, value: unknown) => void }) {
  const headers = (config['headers'] as Record<string, string> | undefined) ?? {}
  const headerRows = Object.entries(headers)

  function setHeader(idx: number, field: 'key' | 'value', val: string) {
    const rows = [...headerRows]
    rows[idx] = field === 'key' ? [val, rows[idx]?.[1] ?? ''] : [rows[idx]?.[0] ?? '', val]
    updateConfig('headers', Object.fromEntries(rows.filter(([k]) => k !== '')))
  }
  function addHeader() {
    updateConfig('headers', { ...headers, '': '' })
  }
  function removeHeader(idx: number) {
    updateConfig('headers', Object.fromEntries(headerRows.filter((_, i) => i !== idx)))
  }

  return (
    <>
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Request Headers</span>
          <button type="button" onClick={addHeader} className="text-xs px-2 py-0.5 rounded transition-colors focus-ring" style={{ color: 'var(--m3-primary)', border: '1px solid color-mix(in srgb, var(--m3-primary) 30%, transparent)' }}>+ Add</button>
        </div>
        {headerRows.length === 0 && <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No custom headers.</p>}
        <div className="space-y-1.5">
          {headerRows.map(([k, v], idx) => (
            <div key={idx} className="flex gap-1.5 items-center">
              <input className="input-sig text-xs flex-1 min-w-0" placeholder="Header name" aria-label={`Header ${idx + 1} name`} value={k} onChange={(e) => setHeader(idx, 'key', e.target.value)} />
              <input className="input-sig text-xs flex-1 min-w-0" placeholder="Value" aria-label={`Header ${idx + 1} value`} value={v} onChange={(e) => setHeader(idx, 'value', e.target.value)} />
              <button type="button" onClick={() => removeHeader(idx)} aria-label={k ? `Remove header ${k}` : `Remove header ${idx + 1}`} title="Remove header" className="btn-icon text-sm leading-none">×</button>
            </div>
          ))}
        </div>
      </div>
      <div>
        <label htmlFor="monitor-request-body" className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Request Body (JSON)</label>
        <textarea id="monitor-request-body" className="input-sig text-xs w-full font-mono" rows={10} placeholder={'{\n  "key": "value"\n}'} value={(config['body'] as string) ?? ''} onChange={(e) => updateConfig('body', e.target.value)} style={{ resize: 'vertical' }} />
      </div>
    </>
  )
}

// ── Alert channels ────────────────────────────────────────────────────────────

export function ChannelsSection({ channels, selected, onChange }: {
  channels: NotificationChannel[]
  selected: Set<number>
  onChange: (update: (prev: Set<number>) => Set<number>) => void
}) {
  return (
    <div className="space-y-2">
      {channels.length === 0 && (
        <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No notification channels configured. Create one in the Notifications section.</p>
      )}
      {channels.map((ch) => (
        <SelectableRow key={ch.id} checked={selected.has(ch.id)} onChange={(on) => onChange((prev) => toggleInSet(prev, ch.id, on))}>
          <span className="material-symbols-outlined flex-shrink-0" aria-hidden="true" style={{ fontSize: '16px', color: 'var(--admin-icon-color)' }}>
            {ch.type === 'email' ? 'mail' : 'webhook'}
          </span>
          <span className="text-sm flex-1" style={{ color: 'var(--m3-on-surface)' }}>{ch.name}</span>
          {!ch.enabled && <span className="text-xs" style={{ color: 'var(--m3-secondary)' }}>disabled</span>}
        </SelectableRow>
      ))}
    </div>
  )
}

// ── Dependencies ──────────────────────────────────────────────────────────────

export function DependenciesSection({ monitors, selected, onChange }: {
  /** Candidate upstream monitors, already excluding the one being edited. */
  monitors: { id: number; name: string }[]
  selected: Set<number>
  onChange: (update: (prev: Set<number>) => Set<number>) => void
}) {
  return (
    <div className="space-y-3">
      <Note tone="info">
        If a selected dependency goes <strong>down</strong>, this monitor will show <strong>Affected</strong> instead of Down — suppressing duplicate alerts for the same root cause.
      </Note>
      <div className="space-y-1.5">
        {monitors.length === 0 && (
          <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No other monitors available.</p>
        )}
        {monitors.map((m) => (
          <SelectableRow key={m.id} checked={selected.has(m.id)} onChange={(on) => onChange((prev) => toggleInSet(prev, m.id, on))}>
            <span className="material-symbols-outlined flex-shrink-0" aria-hidden="true" style={{ fontSize: '16px', color: 'var(--admin-icon-color)' }}>monitor_heart</span>
            <span className="text-sm flex-1" style={{ color: 'var(--m3-on-surface)' }}>{m.name}</span>
          </SelectableRow>
        ))}
      </div>
    </div>
  )
}

function SelectableRow({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer select-none rounded-lg px-3 py-2 transition-colors hover:bg-surface-container"
      style={{ border: '1px solid var(--m3-outline-variant)' }}
    >
      <input type="checkbox" checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded"
      />
      {children}
    </label>
  )
}
