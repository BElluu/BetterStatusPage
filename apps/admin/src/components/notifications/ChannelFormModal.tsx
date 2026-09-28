import { useState } from 'react'
import { api } from '../../api/client'
import { DEFAULT_ALERT_POLICY } from '@bsp/shared'
import type { ChannelAlertPolicy, NotificationChannel } from '@bsp/shared'
import { CHANNEL_TYPES, CHANNEL_TYPE_ORDER, Field, buildChannelConfig, initialDrafts, isChannelType, type ChannelDrafts, type ChannelType } from './channelTypes'
import { ModalShell } from '../ModalShell'
import { SidePanelFrame, SideTabStrip, type SidePanelMeta, type SideTab } from '../SidePanel'

interface Props {
  channel: NotificationChannel | null
  onClose: () => void
  onSaved: () => void
}

type ChannelPanelKey = 'hygiene'

const PANEL_META: Record<ChannelPanelKey, SidePanelMeta> = {
  hygiene: { icon: 'notifications_paused', label: 'Alert hygiene' },
}

const FALLBACK_TIMEZONES = ['UTC', 'Europe/Warsaw', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo']

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Full IANA list where the runtime exposes it, a short curated list otherwise. */
function timezoneOptions(selected: string): string[] {
  let zones = FALLBACK_TIMEZONES
  try {
    const supportedValuesOf = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
    if (supportedValuesOf) zones = supportedValuesOf.call(Intl, 'timeZone')
  } catch { /* keep the fallback list */ }
  return zones.includes(selected) ? zones : [selected, ...zones]
}

/** Older channels predate the policy column, so every section falls back to its default. */
function readAlertPolicy(channel: NotificationChannel | null): ChannelAlertPolicy {
  const stored = channel?.alertPolicy
  return {
    quietHours: { ...DEFAULT_ALERT_POLICY.quietHours, timezone: browserTimezone(), ...(stored?.quietHours ?? {}) },
    throttle: { ...DEFAULT_ALERT_POLICY.throttle, ...(stored?.throttle ?? {}) },
    grouping: { ...DEFAULT_ALERT_POLICY.grouping, ...(stored?.grouping ?? {}) },
  }
}

export default function ChannelFormModal({ channel, onClose, onSaved }: Props) {
  const isEdit = !!channel
  const [name, setName]   = useState(channel?.name ?? '')
  const [type, setType]   = useState<ChannelType>(isChannelType(channel?.type) ? channel.type : 'email')
  const [enabled, setEnabled]               = useState((channel?.enabled ?? 1) === 1)
  const [notifyOnRecovery, setNotifyOnRecovery] = useState((channel?.notifyOnRecovery ?? 0) === 1)

  // One draft per channel type; the descriptor table in channelTypes.tsx knows how to read, edit and build each.
  const [drafts, setDrafts] = useState<ChannelDrafts>(() => initialDrafts(isChannelType(channel?.type) ? channel.type : null, channel?.config))
  function setDraft<K extends ChannelType>(key: K, draft: ChannelDrafts[K]) {
    setDrafts((current) => ({ ...current, [key]: draft }))
  }

  // Alert hygiene
  const initialPolicy = readAlertPolicy(channel)
  const [quietEnabled, setQuietEnabled]     = useState(initialPolicy.quietHours.enabled)
  const [quietStart, setQuietStart]         = useState(initialPolicy.quietHours.start)
  const [quietEnd, setQuietEnd]             = useState(initialPolicy.quietHours.end)
  const [quietTimezone, setQuietTimezone]   = useState(initialPolicy.quietHours.timezone)
  const [quietMode, setQuietMode]           = useState<'defer' | 'suppress'>(initialPolicy.quietHours.mode)
  const [throttleEnabled, setThrottleEnabled] = useState(initialPolicy.throttle.enabled)
  const [throttleMax, setThrottleMax]         = useState(initialPolicy.throttle.maxAlerts)
  const [throttleWindow, setThrottleWindow]   = useState(initialPolicy.throttle.windowMinutes)
  const [groupEnabled, setGroupEnabled]     = useState(initialPolicy.grouping.enabled)
  const [groupMin, setGroupMin]             = useState(initialPolicy.grouping.minMonitors)
  const [groupWindow, setGroupWindow]       = useState(initialPolicy.grouping.windowSeconds)

  const [sidePanel, setSidePanel] = useState<ChannelPanelKey | null>(null)
  const activePolicies = [quietEnabled, throttleEnabled, groupEnabled].filter(Boolean).length
  const sideTabs: SideTab<ChannelPanelKey>[] = [
    { key: 'hygiene', badge: activePolicies > 0 ? String(activePolicies) : null },
  ]

  const [loading, setLoading]   = useState(false)
  const [testing, setTesting]   = useState(false)
  const [testMsg, setTestMsg]   = useState<{ ok: boolean; text: string } | null>(null)
  const [error, setError]       = useState('')

  function buildAlertPolicy(): ChannelAlertPolicy {
    return {
      quietHours: { enabled: quietEnabled, start: quietStart, end: quietEnd, timezone: quietTimezone, mode: quietMode },
      throttle: { enabled: throttleEnabled, maxAlerts: throttleMax, windowMinutes: throttleWindow },
      grouping: { enabled: groupEnabled, minMonitors: groupMin, windowSeconds: groupWindow },
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const body = {
        name, type, config: buildChannelConfig(type, drafts),
        enabled: enabled ? 1 : 0,
        notifyOnRecovery: notifyOnRecovery ? 1 : 0,
        alertPolicy: buildAlertPolicy(),
      }
      if (isEdit) {
        await api.patch(`/admin/notifications/channels/${channel.id}`, body)
      } else {
        await api.post('/admin/notifications/channels', body)
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleTest() {
    if (!isEdit) return
    setTesting(true)
    setTestMsg(null)
    try {
      await api.post(`/admin/notifications/channels/${channel.id}/test`, {})
      setTestMsg({ ok: true, text: 'Test sent successfully' })
    } catch (err) {
      setTestMsg({ ok: false, text: err instanceof Error ? err.message : 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <ModalShell align="top">
      <div
        className="rounded-2xl my-8"
        style={{
          display: 'flex', flexDirection: 'row',
          width: sidePanel ? 'min(1024px, calc(100vw - 32px))' : 'min(620px, calc(100vw - 32px))',
          background: 'var(--m3-surface-container-low)',
          border: '1px solid var(--m3-outline-variant)',
          transition: 'width 0.2s ease',
        }}
      >
      <div style={{ flex: '0 0 auto', width: sidePanel ? '576px' : 'calc(100% - 44px)', minWidth: 0 }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <h3 className="font-headline font-bold text-lg" style={{ color: 'var(--m3-on-surface)' }}>
            {isEdit ? 'Edit Channel' : 'New Notification Channel'}
          </h3>
          <button onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-xl leading-none transition-colors"
            style={{ color: 'var(--m3-secondary)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-surface-container-high)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '' }}
          >×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="rounded-lg px-4 py-3 text-sm" style={{ background: 'rgba(255,77,106,0.08)', border: '1px solid rgba(255,77,106,0.2)', color: 'var(--m3-down)' }}>
              {error}
            </div>
          )}

          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} required className="input-sig" placeholder="My Email Alert" />
          </Field>

          {/* Type toggle */}
          <div>
            <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Type</label>
            <div className="flex rounded-lg p-1 gap-1" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
              {CHANNEL_TYPE_ORDER.map((id) => (
                <button key={id} type="button" onClick={() => setType(id)}
                  className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-all flex items-center justify-center gap-1.5 ${type === id ? 'selection-active' : ''}`}
                  style={type === id
                    ? { background: 'var(--m3-primary-fixed)', color: 'var(--m3-primary)', border: '1px solid color-mix(in srgb, var(--m3-primary) 25%, transparent)' }
                    : { color: 'var(--m3-secondary)', border: '1px solid transparent' }
                  }
                >
                  {CHANNEL_TYPES[id].icon(14)}
                  {CHANNEL_TYPES[id].label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

          <ChannelTypeFields type={type} drafts={drafts} onChange={setDraft} />

          <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

          {/* Toggles */}
          <div className="space-y-3">
            <Toggle label="Enabled" checked={enabled} onChange={setEnabled} />
            <Toggle label="Notify on recovery (when monitor comes back up)" checked={notifyOnRecovery} onChange={setNotifyOnRecovery} />
          </div>

          {/* Test result */}
          {testMsg && (
            <div className="rounded-lg px-4 py-3 text-xs"
              style={{
                background: testMsg.ok ? 'rgba(34,197,94,0.08)' : 'rgba(255,77,106,0.08)',
                border: `1px solid ${testMsg.ok ? 'rgba(34,197,94,0.25)' : 'rgba(255,77,106,0.2)'}`,
                color: testMsg.ok ? 'var(--m3-up-bar)' : 'var(--m3-down)',
              }}
            >
              {testMsg.text}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg"
              style={{ color: 'var(--m3-secondary)' }}
            >Cancel</button>
            {isEdit && (
              <button type="button" onClick={handleTest} disabled={testing}
                className="px-4 py-2 text-sm font-semibold rounded-lg transition-all flex items-center gap-1.5"
                style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface)', border: '1px solid var(--m3-outline-variant)', opacity: testing ? 0.7 : 1 }}
              >
                {testing ? <><span className="material-symbols-outlined animate-spin" style={{ fontSize: '15px' }}>progress_activity</span> Testing…</> : 'Send Test'}
              </button>
            )}
            <button type="submit" disabled={loading}
              className="btn-primary px-4 py-2 text-sm font-semibold rounded-lg transition-all"
              style={{ background: loading ? 'var(--m3-surface-container-high)' : 'var(--m3-primary)', color: loading ? 'var(--m3-secondary)' : 'var(--m3-on-primary)', opacity: loading ? 0.7 : 1 }}
            >
              {loading ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Channel'}
            </button>
          </div>
        </form>
      </div>{/* main column */}

      {sidePanel === 'hygiene' && (
        <SidePanelFrame meta={PANEL_META.hygiene}>
          <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
            Everything here is off by default. Suppressed notifications still appear in the delivery history with the reason.
          </p>

          <PolicyBlock
            label="Quiet hours"
            hint="Silence this channel during a recurring local-time window. A window ending at or before it starts wraps past midnight."
            checked={quietEnabled}
            onChange={setQuietEnabled}
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="From">
                <input type="time" value={quietStart} onChange={(e) => setQuietStart(e.target.value)} className="input-sig" />
              </Field>
              <Field label="To">
                <input type="time" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} className="input-sig" />
              </Field>
            </div>
            <Field label="Timezone">
              <select value={quietTimezone} onChange={(e) => setQuietTimezone(e.target.value)} className="input-sig">
                {timezoneOptions(quietTimezone).map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </select>
            </Field>
            <Field label="During the window">
              <select value={quietMode} onChange={(e) => setQuietMode(e.target.value as 'defer' | 'suppress')} className="input-sig">
                <option value="defer">Hold notifications and send them when it ends</option>
                <option value="suppress">Drop notifications entirely</option>
              </select>
            </Field>
          </PolicyBlock>

          <PolicyBlock
            label="Rate cap per monitor"
            hint="Caps how often a single monitor may alert on this channel. Recoveries are never capped."
            checked={throttleEnabled}
            onChange={setThrottleEnabled}
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="Max alerts">
                <input type="number" min={1} max={100} value={throttleMax} onChange={(e) => setThrottleMax(Math.max(1, Number(e.target.value)))} className="input-sig" />
              </Field>
              <Field label="Per (minutes)">
                <input type="number" min={1} max={1440} value={throttleWindow} onChange={(e) => setThrottleWindow(Math.max(1, Number(e.target.value)))} className="input-sig" />
              </Field>
            </div>
          </PolicyBlock>

          <PolicyBlock
            label="Group bursts into one message"
            hint="Delays notifications by the window. If enough distinct monitors fire inside it, one digest goes out instead of many; otherwise they are sent individually."
            checked={groupEnabled}
            onChange={setGroupEnabled}
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="From (monitors)">
                <input type="number" min={2} max={100} value={groupMin} onChange={(e) => setGroupMin(Math.max(2, Number(e.target.value)))} className="input-sig" />
              </Field>
              <Field label="Within (seconds)">
                <input type="number" min={10} max={900} value={groupWindow} onChange={(e) => setGroupWindow(Math.max(10, Number(e.target.value)))} className="input-sig" />
              </Field>
            </div>
          </PolicyBlock>
        </SidePanelFrame>
      )}

      <SideTabStrip tabs={sideTabs} meta={PANEL_META} active={sidePanel} onToggle={setSidePanel} />
      </div>{/* outer flex row */}
    </ModalShell>
  )
}

function PolicyBlock({ label, hint, checked, onChange, children }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode
}) {
  return (
    <div className="rounded-lg px-3 py-3 space-y-3" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
      <Toggle label={label} checked={checked} onChange={onChange} />
      <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>{hint}</p>
      {checked && <div className="space-y-3 pt-1">{children}</div>}
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer select-none">
      <div
        className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
        style={{ background: checked ? 'var(--m3-primary)' : 'var(--m3-outline-variant)' }}
        onClick={() => onChange(!checked)}
      >
        <div
          className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
          style={{ background: checked ? 'var(--m3-on-primary)' : 'var(--m3-secondary)', left: checked ? '22px' : '2px' }}
        />
      </div>
      <span className="text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>{label}</span>
    </label>
  )
}

/** Renders the edit fields of the selected type from its descriptor. */
function ChannelTypeFields<K extends ChannelType>({ type, drafts, onChange }: {
  type: K
  drafts: ChannelDrafts
  onChange: (type: K, draft: ChannelDrafts[K]) => void
}) {
  const { Fields } = CHANNEL_TYPES[type]
  return <Fields draft={drafts[type]} onChange={(draft) => onChange(type, draft)} />
}
