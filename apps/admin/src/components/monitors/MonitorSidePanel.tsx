import type { ReactNode } from 'react'
import type { NotificationChannel } from '@bsp/shared'
import { Note, toggleInSet } from './monitorFormParts'

export type SidePanelKey = 'request' | 'auth' | 'tags' | 'channels' | 'dependencies'

const PANEL_META: Record<SidePanelKey, { icon: string; label: string }> = {
  auth:         { icon: 'lock',          label: 'Auth' },
  request:      { icon: 'tune',          label: 'Request' },
  tags:         { icon: 'label',         label: 'Tags' },
  channels:     { icon: 'notifications', label: 'Alerts' },
  dependencies: { icon: 'account_tree',  label: 'Depends on' },
}

/** The expandable column to the right of the monitor form: a title bar and the open section. */
export function SidePanelFrame({ panel, children }: { panel: SidePanelKey; children: ReactNode }) {
  const current = PANEL_META[panel]
  return (
    <div style={{ flex: 1, minWidth: '360px', borderLeft: '1px solid var(--m3-outline-variant)', display: 'flex', flexDirection: 'column' }}>
      {/* Panel header — just the section title */}
      <div className="flex items-center gap-2 px-5 py-4" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
        <span className="material-symbols-outlined" style={{ fontSize: '16px', color: 'var(--m3-primary)' }}>{current.icon}</span>
        <span className="font-mono text-xs uppercase tracking-wider font-medium" style={{ color: 'var(--m3-on-surface)', flex: 1 }}>{current.label}</span>
      </div>

      {/* Tab content */}
      <div className="p-5 space-y-4 overflow-y-auto" style={{ flex: 1 }}>
        {children}
      </div>
    </div>
  )
}

export interface SideTab { key: SidePanelKey; badge: string | null }

/** The vertical icon strip that opens and closes side-panel sections. */
export function SideTabStrip({ tabs, active, onToggle }: { tabs: SideTab[]; active: SidePanelKey | null; onToggle: (key: SidePanelKey | null) => void }) {
  return (
    <div style={{ flex: '0 0 44px', borderLeft: '1px solid var(--m3-outline-variant)', display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
      {tabs.map((tab) => {
        const isActive = active === tab.key
        const meta = PANEL_META[tab.key]
        return (
          <button key={tab.key} type="button"
            title={meta.label}
            onClick={() => onToggle(isActive ? null : tab.key)}
            className={`relative flex flex-col items-center justify-center py-4 transition-all ${isActive ? 'monitor-side-tab-active' : ''}`}
            style={{ color: isActive ? 'var(--m3-primary)' : 'var(--m3-secondary)', background: isActive ? 'var(--m3-primary-fixed)' : 'transparent', borderBottom: '1px solid var(--m3-outline-variant)' }}
            onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-surface-container)' }}
            onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = '' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>{meta.icon}</span>
            {tab.badge && (
              <span className={`absolute top-1.5 right-1 flex items-center justify-center rounded-full font-bold leading-none ${isActive ? 'monitor-side-tab-badge-active' : ''}`}
                style={{ background: isActive ? 'var(--m3-primary)' : 'var(--m3-on-surface-variant)', color: isActive ? 'var(--m3-on-primary)' : 'var(--m3-surface)', minWidth: '14px', height: '14px', fontSize: '9px', padding: '0 2px' }}>
                {tab.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
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
          <label className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Request Headers</label>
          <button type="button" onClick={addHeader} className="text-xs px-2 py-0.5 rounded transition-colors" style={{ color: 'var(--m3-primary)', border: '1px solid color-mix(in srgb, var(--m3-primary) 30%, transparent)' }}>+ Add</button>
        </div>
        {headerRows.length === 0 && <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No custom headers.</p>}
        <div className="space-y-1.5">
          {headerRows.map(([k, v], idx) => (
            <div key={idx} className="flex gap-1.5 items-center">
              <input className="input-sig text-xs flex-1" placeholder="Header name" value={k} onChange={(e) => setHeader(idx, 'key', e.target.value)} />
              <input className="input-sig text-xs flex-1" placeholder="Value" value={v} onChange={(e) => setHeader(idx, 'value', e.target.value)} />
              <button type="button" onClick={() => removeHeader(idx)} className="w-6 h-6 flex items-center justify-center rounded text-sm leading-none flex-shrink-0" style={{ color: 'var(--m3-secondary)' }}>×</button>
            </div>
          ))}
        </div>
      </div>
      <div>
        <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Request Body (JSON)</label>
        <textarea className="input-sig text-xs w-full font-mono" rows={10} placeholder={'{\n  "key": "value"\n}'} value={(config['body'] as string) ?? ''} onChange={(e) => updateConfig('body', e.target.value)} style={{ resize: 'vertical' }} />
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
          <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: '16px', color: ch.type === 'email' ? '#6366f1' : '#10b981' }}>
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
            <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: '16px', color: 'var(--m3-secondary)' }}>monitor_heart</span>
            <span className="text-sm flex-1" style={{ color: 'var(--m3-on-surface)' }}>{m.name}</span>
          </SelectableRow>
        ))}
      </div>
    </div>
  )
}

function SelectableRow({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer select-none rounded-lg px-3 py-2 transition-colors"
      style={{ border: '1px solid var(--m3-outline-variant)' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--m3-surface-container)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
    >
      <input type="checkbox" checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded accent-[color:var(--m3-primary)]"
      />
      {children}
    </label>
  )
}
