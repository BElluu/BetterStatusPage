import { useEffect, useId, useState } from 'react'
import { api } from '../../api/client'
import { DEFAULT_ALERT_POLICY } from '@bsp/shared'
import { YamlViewModal } from '../YamlViewModal'
import type { ChannelAlertPolicy, NotificationChannel } from '@bsp/shared'
import { ChannelTypePicker } from './ChannelTypePicker'
import { CHANNEL_TYPES, Field, buildChannelConfig, initialDrafts, isChannelType, type ChannelDrafts, type ChannelType } from './channelTypes'
import { ModalHeader, ModalShell } from '../ModalShell'
import { SidePanelFrame, SideTabStrip, type SidePanelMeta, type SideTab } from '../SidePanel'
import { Alert, Switch } from '../ui'
import type { VaultPickerProps } from '../monitors/monitorFormParts'

interface Props {
  channel: NotificationChannel | null
  /** Type preselected when creating a channel; ignored when editing. */
  initialType?: ChannelType | undefined
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

export default function ChannelFormModal({ channel, initialType, onClose, onSaved }: Props) {
  const isEdit = !!channel
  const [showYaml, setShowYaml] = useState(false)
  const [name, setName]   = useState(channel?.name ?? '')
  const [type, setType]   = useState<ChannelType>(isChannelType(channel?.type) ? channel.type : (initialType ?? 'email'))
  const [enabled, setEnabled]               = useState((channel?.enabled ?? 1) === 1)
  const [notifyOnRecovery, setNotifyOnRecovery] = useState((channel?.notifyOnRecovery ?? 0) === 1)

  // One draft per channel type; the descriptor table in channelTypes.tsx knows how to read, edit and build each.
  const [drafts, setDrafts] = useState<ChannelDrafts>(() => initialDrafts(isChannelType(channel?.type) ? channel.type : null, channel?.config))
  function setDraft<K extends ChannelType>(key: K, draft: ChannelDrafts[K]) {
    setDrafts((current) => ({ ...current, [key]: draft }))
  }

  // Vaults for the credential fields; secrets load per vault, the stored one right away.
  const [vaults, setVaults] = useState<VaultPickerProps['vaults']>([])
  const [secretsByVault, setSecretsByVault] = useState<VaultPickerProps['secretsByVault']>({})
  async function loadSecrets(vaultId: number) {
    if (secretsByVault[vaultId]) return
    try {
      const secrets = await api.get<VaultPickerProps['secretsByVault'][number]>(`/admin/vaults/${vaultId}/secrets`)
      setSecretsByVault((prev) => ({ ...prev, [vaultId]: secrets }))
    } catch { /* the picker shows an empty secret list */ }
  }
  useEffect(() => {
    api.get<VaultPickerProps['vaults']>('/admin/vaults').then(setVaults).catch(() => {})
    const storedVaultId = drafts.telegram.vault?.vaultId
    if (storedVaultId) loadSecrets(storedVaultId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const vaultPicker: VaultPickerProps = { vaults, secretsByVault, onLoadSecrets: loadSecrets }

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

  // "Send test" exercises the stored channel on the server, so it is only meaningful while the form matches it.
  const snapshot = JSON.stringify({ name, type, config: buildChannelConfig(type, drafts), enabled, notifyOnRecovery, alertPolicy: buildAlertPolicy() })
  const [savedSnapshot] = useState(snapshot)
  const dirty = snapshot !== savedSnapshot
  const titleId = useId()
  const testHintId = useId()

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
    <ModalShell align="top" onClose={loading ? undefined : onClose} labelledBy={titleId}>
      <div
        className="rounded-2xl my-8 flex flex-col lg:flex-row"
        style={{
          width: sidePanel ? 'min(1024px, calc(100vw - 32px))' : 'min(620px, calc(100vw - 32px))',
          background: 'var(--m3-surface-container-low)',
          border: '1px solid var(--m3-outline-variant)',
          transition: 'width 0.2s ease',
        }}
      >
      <div className={`flex-none min-w-0 w-full ${sidePanel ? 'lg:w-[560px]' : 'lg:w-[calc(100%-44px)]'}`}>
        {/* Header */}
        <ModalHeader icon="notifications" titleId={titleId} title={isEdit ? 'Edit Channel' : 'New Notification Channel'} onClose={onClose} />

        <form onSubmit={handleSubmit} className="p-4 sm:p-6 space-y-4">
          {error && <Alert tone="error">{error}</Alert>}

          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} required className="input-sig" placeholder="My Email Alert" />
          </Field>


          <ChannelTypePicker value={type} onChange={setType} />

          <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

          <ChannelTypeFields type={type} drafts={drafts} onChange={setDraft} vaultPicker={vaultPicker} />

          <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

          {/* Toggles */}
          <div className="space-y-3">
            <Switch label="Enabled" checked={enabled} onChange={setEnabled} />
            <Switch label="Notify on recovery (when monitor comes back up)" checked={notifyOnRecovery} onChange={setNotifyOnRecovery} />
          </div>

          {/* Test result */}
          {testMsg && <Alert tone={testMsg.ok ? 'success' : 'error'}>{testMsg.text}</Alert>}

          {isEdit && dirty && (
            <p id={testHintId} className="text-xs text-right" style={{ color: 'var(--m3-secondary)' }}>
              Save your changes first — the test uses the saved channel settings.
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap gap-3">
              {isEdit && (
                <button type="button" onClick={() => setShowYaml(true)} title="The saved channel as YAML" className="btn btn-secondary">
                  <span className="material-symbols-outlined" aria-hidden="true">data_object</span>
                  YAML
                </button>
              )}
              {isEdit && (
                <button type="button" onClick={handleTest} disabled={testing || dirty}
                  aria-describedby={dirty ? testHintId : undefined}
                  className="btn btn-secondary"
                >
                  {testing
                    ? <><span className="material-symbols-outlined animate-spin" aria-hidden="true">progress_activity</span> Testing…</>
                    : 'Send test (saved settings)'}
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-3 ml-auto">
              <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={loading} className="btn btn-primary">
                {loading ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Channel'}
              </button>
            </div>
          </div>
        </form>
      </div>{/* main column */}

      {sidePanel === 'hygiene' && (
        <SidePanelFrame meta={PANEL_META.hygiene} layout="responsive">
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

      <SideTabStrip tabs={sideTabs} meta={PANEL_META} active={sidePanel} onToggle={setSidePanel} layout="responsive" />
      </div>{/* outer flex row */}
      {showYaml && channel && <YamlViewModal kind="NotificationChannel" objectKey={channel.key} title={channel.name} onClose={() => setShowYaml(false)} />}
    </ModalShell>
  )
}

function PolicyBlock({ label, hint, checked, onChange, children }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode
}) {
  return (
    <div className="rounded-lg px-3 py-3 space-y-3" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
      <Switch label={label} description={hint} checked={checked} onChange={onChange} />
      {checked && <div className="space-y-3 pt-1">{children}</div>}
    </div>
  )
}

/** Renders the edit fields of the selected type from its descriptor. */
function ChannelTypeFields<K extends ChannelType>({ type, drafts, onChange, vaultPicker }: {
  type: K
  drafts: ChannelDrafts
  onChange: (type: K, draft: ChannelDrafts[K]) => void
  vaultPicker: VaultPickerProps
}) {
  const { Fields } = CHANNEL_TYPES[type]
  return <Fields draft={drafts[type]} onChange={(draft) => onChange(type, draft)} vaultPicker={vaultPicker} />
}
