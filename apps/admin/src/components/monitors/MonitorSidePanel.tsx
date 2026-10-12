import type { ReactNode } from 'react'
import type { Action, MonitorAction, NotificationChannel, VaultRef } from '@bsp/shared'
import type { SidePanelMeta } from '../SidePanel'
import { ConnectionStringSection, CredentialSection } from './CredentialSection'
import { Field, JSON_MAPPING_FIELDS, Note, toggleInSet, type VaultPickerProps } from './monitorFormParts'

export type SidePanelKey = 'request' | 'auth' | 'credentials' | 'tags' | 'channels' | 'actions' | 'dependencies' | 'incident'

export const PANEL_META: Record<SidePanelKey, SidePanelMeta> = {
  auth:         { icon: 'lock',          label: 'Auth' },
  credentials:  { icon: 'lock',          label: 'Credentials' },
  request:      { icon: 'tune',          label: 'Request' },
  tags:         { icon: 'label',         label: 'Tags' },
  channels:     { icon: 'notifications', label: 'Alerts' },
  actions:      { icon: 'bolt',          label: 'Actions' },
  dependencies: { icon: 'account_tree',  label: 'Depends on' },
  incident:     { icon: 'emergency_home', label: 'Incident' },
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

/** True once a database monitor has what it needs to sign in: a Vault secret, or a user and password typed in. */
export function hasDatabaseCredentials(config: Record<string, unknown>): boolean {
  const vault = config['vault'] as VaultRef | undefined
  if (vault) return vault.secretId > 0
  if (config['mode'] === 'connectionString') return false
  return !!config['user'] && !!config['password']
}

/** How a database monitor signs in: a connection string held in Vault, or a user and password (typed or from Vault). */
export function CredentialsSection({ config, updateConfig, vaultPicker }: {
  config: Record<string, unknown>
  updateConfig: (key: string, value: unknown) => void
  vaultPicker: VaultPickerProps
}) {
  const vault = config['vault'] as VaultRef | undefined
  if (config['mode'] === 'connectionString') {
    return <ConnectionStringSection {...vaultPicker} vault={vault} onVaultChange={(v) => updateConfig('vault', v)} />
  }
  return (
    <CredentialSection
      {...vaultPicker}
      vault={vault}
      onVaultChange={(v) => {
        updateConfig('vault', v)
        // Switching to a vault drops what was typed in directly, so the two never exist together.
        if (v) { updateConfig('user', undefined); updateConfig('password', undefined) }
      }}
      mappingFields={JSON_MAPPING_FIELDS.database}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="User">
          <input value={(config['user'] as string) ?? ''} onChange={(e) => updateConfig('user', e.target.value)} className="input-sig" autoComplete="off" />
        </Field>
        <Field label="Password">
          <input type="password" value={(config['password'] as string) ?? ''} onChange={(e) => updateConfig('password', e.target.value)} onFocus={(e) => e.target.select()} className="input-sig" autoComplete="new-password" />
        </Field>
      </div>
    </CredentialSection>
  )
}

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

// ── Actions ───────────────────────────────────────────────────────────────────

export function ActionsSection({ actions, links, onChange }: {
  actions: Action[]
  links: MonitorAction[]
  onChange: (links: MonitorAction[]) => void
}) {
  const update = (index: number, patch: Partial<MonitorAction>) =>
    onChange(links.map((link, i) => (i === index ? { ...link, ...patch } : link)))

  return (
    <div className="space-y-3">
      <Note tone="info">
        An action runs once the monitor has been <strong>down</strong> for the delay you set, and is dropped if the monitor recovers first.
        An <strong>up</strong> action runs after an outage ends. The cooldown stops the same action from running again too soon.
      </Note>
      {actions.length === 0 && (
        <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No actions configured. Create one in the Actions section.</p>
      )}
      {links.map((link, i) => (
        <div key={i} className="rounded-lg px-3 py-3 space-y-3" style={{ border: '1px solid var(--m3-outline-variant)' }}>
          <div className="flex items-center gap-2">
            <select value={link.actionId} onChange={(e) => update(i, { actionId: Number(e.target.value) })}
              aria-label={`Action ${i + 1}`} className="input-sig flex-1 min-w-0">
              {actions.map((a) => <option key={a.id} value={a.id}>{a.name}{a.enabled ? '' : ' (disabled)'}</option>)}
            </select>
            <button type="button" onClick={() => onChange(links.filter((_, idx) => idx !== i))}
              aria-label={`Remove action ${i + 1}`} className="btn-icon w-7 h-7">
              <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>close</span>
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Field label="When monitor is">
              <select value={link.onStatus} onChange={(e) => update(i, { onStatus: e.target.value as MonitorAction['onStatus'] })} className="input-sig">
                <option value="down">down</option>
                <option value="up">back up</option>
              </select>
            </Field>
            <Field label="After (min)">
              <input type="number" min={0} max={10080} value={link.delayMinutes}
                onChange={(e) => update(i, { delayMinutes: Math.max(0, Math.floor(Number(e.target.value)) || 0) })} className="input-sig" />
            </Field>
            <Field label="Cooldown (min)">
              <input type="number" min={0} max={10080} value={link.cooldownMinutes}
                onChange={(e) => update(i, { cooldownMinutes: Math.max(0, Math.floor(Number(e.target.value)) || 0) })} className="input-sig" />
            </Field>
          </div>
        </div>
      ))}
      <button type="button" disabled={actions.length === 0}
        onClick={() => onChange([...links, { actionId: actions[0]!.id, onStatus: 'down', delayMinutes: 0, cooldownMinutes: 0 }])}
        className="btn btn-outline btn-sm">
        + Add action
      </button>
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
