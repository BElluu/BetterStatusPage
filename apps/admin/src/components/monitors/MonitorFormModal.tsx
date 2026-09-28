import { useState, useEffect } from 'react'
import { api } from '../../api/client'
import type { Monitor, MonitorType, NotificationChannel, MonitorTag } from '@bsp/shared'
import { ModalShell } from '../ModalShell'
import { AuthSection, readAuth } from './AuthSection'
import { SidePanelFrame, SideTabStrip, type SideTab } from '../SidePanel'
import { ChannelsSection, DependenciesSection, PANEL_META, RequestSection, type SidePanelKey } from './MonitorSidePanel'
import { MonitorTypeConfigFields } from './MonitorTypeConfigFields'
import { Field, type SecretSummary, type VaultSummary } from './monitorFormParts'
import { TagsSection } from './TagsSection'
import { TestResultPanel, type TestResult } from './TestResultPanel'

interface Props {
  monitor: Monitor | null
  allTags?: MonitorTag[]
  onClose: () => void
  onSaved: () => void
}

const defaultConfigs: Record<MonitorType, Record<string, unknown>> = {
  https:     { url: 'https://', method: 'GET', expectedStatus: 200 },
  ping:      { host: '', mode: 'tcp', port: 80 },
  dns:       { hostname: '', recordType: 'A' },
  sqlserver: { host: '', port: 1433, database: '', user: '', password: '', query: 'SELECT 1' },
  webhook:   {},
}

const MONITOR_TYPES: { value: MonitorType; label: string }[] = [
  { value: 'https',     label: 'HTTPS' },
  { value: 'ping',      label: 'Ping / TCP' },
  { value: 'dns',       label: 'DNS' },
  { value: 'sqlserver', label: 'SQL Server' },
  { value: 'webhook',   label: 'Webhook' },
]

export default function MonitorFormModal({ monitor, allTags = [], onClose, onSaved }: Props) {
  const isEdit = !!monitor
  const [name, setName]               = useState(monitor?.name ?? '')
  const [type, setType]               = useState<MonitorType>(monitor?.type as MonitorType ?? 'https')
  const [intervalSecs, setIntervalSecs] = useState(monitor?.intervalSecs ?? 60)
  const [timeoutMs, setTimeoutMs]     = useState(monitor?.timeoutMs ?? 10000)
  const [config, setConfig]           = useState<Record<string, unknown>>(
    monitor ? (monitor.config as unknown as Record<string, unknown>) : (defaultConfigs.https as Record<string, unknown>),
  )
  const [retries, setRetries]           = useState(monitor?.retries ?? 1)
  const [failureThreshold, setFailureThreshold]   = useState(monitor?.failureThreshold ?? 1)
  const [recoveryThreshold, setRecoveryThreshold] = useState(monitor?.recoveryThreshold ?? 1)
  const [tags, setTags]                 = useState<MonitorTag[]>(monitor?.tags ?? [])
  const [sidePanel, setSidePanel] = useState<SidePanelKey | null>(null)
  const [webhookToken, setWebhookToken] = useState<string | null>(monitor?.webhookToken ?? null)
  const [resettingToken, setResettingToken] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  const [vaults, setVaults]                 = useState<VaultSummary[]>([])
  const [secretsByVault, setSecretsByVault] = useState<Record<number, SecretSummary[]>>({})
  const [channels, setChannels]             = useState<NotificationChannel[]>([])
  const [selectedChannelIds, setSelectedChannelIds] = useState<Set<number>>(new Set())
  const [allMonitors, setAllMonitors]       = useState<{ id: number; name: string }[]>([])
  const [selectedDependsOnIds, setSelectedDependsOnIds] = useState<Set<number>>(new Set())

  useEffect(() => {
    api.get<VaultSummary[]>('/admin/vaults').then(setVaults).catch(() => {})
    api.get<NotificationChannel[]>('/admin/notifications/channels').then(setChannels).catch(() => {})
    api.get<{ id: number; name: string }[]>('/admin/monitors').then(setAllMonitors).catch(() => {})
    if (monitor) {
      api.get<number[]>(`/admin/notifications/monitor/${monitor.id}/channels`)
        .then((ids) => setSelectedChannelIds(new Set(ids)))
        .catch(() => {})
      api.get<{ dependsOnIds: number[] }>(`/admin/monitors/${monitor.id}/dependencies`)
        .then((r) => setSelectedDependsOnIds(new Set(r.dependsOnIds)))
        .catch(() => {})
    }
  }, [monitor])

  // Pre-load secrets for any vault already configured in the monitor being edited
  // The initial monitor configuration is immutable for the lifetime of the modal.
  useEffect(() => {
    if (!monitor) return
    const cfg = monitor.config as unknown as Record<string, unknown>
    const authCfg = cfg['auth'] as Record<string, unknown> | undefined
    const ids = [
      (authCfg?.['basic'] as Record<string, unknown> | undefined)?.['vault'],
      (authCfg?.['oauth2'] as Record<string, unknown> | undefined)?.['vault'],
      (authCfg?.['cas'] as Record<string, unknown> | undefined)?.['vault'],
      cfg['vault'],
    ]
      .filter(Boolean)
      .map((v) => (v as { vaultId: number }).vaultId)
      .filter((id) => id > 0)
    for (const id of ids) loadSecrets(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadSecrets(vaultId: number) {
    if (secretsByVault[vaultId]) return
    try {
      const secrets = await api.get<SecretSummary[]>(`/admin/vaults/${vaultId}/secrets`)
      setSecretsByVault((prev) => ({ ...prev, [vaultId]: secrets }))
    } catch { /* ignore */ }
  }

  function handleTypeChange(newType: MonitorType) {
    setType(newType)
    setConfig(defaultConfigs[newType] as Record<string, unknown>)
    if (newType !== 'https' && (sidePanel === 'auth' || sidePanel === 'request')) setSidePanel(null)
  }

  function updateConfig(key: string, value: unknown) {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }

  async function handleResetToken() {
    if (!monitor) return
    setResettingToken(true)
    try {
      const updated = await api.post<{ webhookToken: string }>(`/admin/monitors/${monitor.id}/reset-token`, {})
      setWebhookToken(updated.webhookToken)
    } catch { /* ignore */ } finally {
      setResettingToken(false)
    }
  }

  async function handleTest() {
    if (type !== 'https' && type !== 'sqlserver' && type !== 'ping' && type !== 'dns') return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.post<TestResult>('/admin/monitors/test', { type, config, timeoutMs })
      setTestResult(result)
    } catch (err) {
      setTestResult({ overall: 'error', steps: [{ label: 'Test request failed', status: 'error', detail: err instanceof Error ? err.message : String(err) }], totalMs: 0 })
    } finally {
      setTesting(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // "Done" after webhook creation — just close and refresh
    if (type === 'webhook' && !isEdit && webhookToken) { onSaved(); return }

    setError('')
    setLoading(true)
    try {
      const body = { name, type, intervalSecs, timeoutMs, retries, failureThreshold, recoveryThreshold, config, tags }
      if (isEdit) {
        await api.patch(`/admin/monitors/${monitor.id}`, body)
        await api.put(`/admin/notifications/monitor/${monitor.id}/channels`, { channelIds: [...selectedChannelIds] })
        await api.put(`/admin/monitors/${monitor.id}/dependencies`, { dependsOnIds: [...selectedDependsOnIds] })
      } else {
        const created = await api.post<{ id: number; webhookToken?: string | null }>('/admin/monitors', body)
        await api.put(`/admin/notifications/monitor/${created.id}/channels`, { channelIds: [...selectedChannelIds] })
        await api.put(`/admin/monitors/${created.id}/dependencies`, { dependsOnIds: [...selectedDependsOnIds] })
        if (created.webhookToken) setWebhookToken(created.webhookToken)
        if (type !== 'webhook') { onSaved(); return }
        // webhook: stay open so user can copy the URL before closing
        setLoading(false)
        return
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setLoading(false)
    }
  }

  const auth = readAuth(config)
  const authType = auth.type ?? 'none'
  const headerCount = Object.keys((config['headers'] as Record<string, string> | undefined) ?? {}).length
  const vaultPicker = { vaults, secretsByVault, onLoadSecrets: loadSecrets }
  const isTestable = type === 'https' || type === 'sqlserver' || type === 'ping' || type === 'dns'
  const webhookCreated = type === 'webhook' && !isEdit && !!webhookToken

  const sideTabs: SideTab<SidePanelKey>[] = [
    ...(type === 'https' ? [
      { key: 'auth' as const,    badge: authType !== 'none' ? authType.slice(0, 1).toUpperCase() : null },
      { key: 'request' as const, badge: headerCount > 0 ? String(headerCount) : null },
    ] : []),
    { key: 'tags',         badge: tags.length > 0 ? String(tags.length) : null },
    { key: 'channels',     badge: selectedChannelIds.size > 0 ? String(selectedChannelIds.size) : null },
    { key: 'dependencies', badge: selectedDependsOnIds.size > 0 ? String(selectedDependsOnIds.size) : null },
  ]

  return (
    <ModalShell align="top">
      <div
        className="rounded-2xl my-8"
        style={{
          display: 'flex', flexDirection: 'row',
          width: sidePanel ? 'min(1024px, calc(100vw - 32px))' : 'min(604px, calc(100vw - 32px))',
          background: 'var(--m3-surface-container-low)',
          border: '1px solid var(--m3-outline-variant)',
          transition: 'width 0.2s ease',
        }}
      >
      <div style={{ flex: '0 0 auto', width: sidePanel ? '560px' : 'calc(100% - 44px)', minWidth: 0 }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <h3 className="font-headline font-bold text-lg" style={{ color: 'var(--m3-on-surface)' }}>
            {isEdit ? 'Edit Monitor' : 'New Monitor'}
          </h3>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-xl leading-none transition-colors"
            style={{ color: 'var(--m3-secondary)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-surface-container-high)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-on-surface)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = ''; (e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-secondary)' }}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="rounded-lg px-4 py-3 text-sm" style={{ background: 'rgba(255,77,106,0.08)', border: '1px solid rgba(255,77,106,0.2)', color: 'var(--m3-down)' }}>
              {error}
            </div>
          )}

          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} required className="input-sig" placeholder="My Service" />
          </Field>

          {/* Type tabs */}
          <div>
            <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Type</label>
            <div className="flex rounded-lg p-1 gap-1" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
              {MONITOR_TYPES.map((t) => (
                <button key={t.value} type="button" onClick={() => handleTypeChange(t.value)}
                  className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-all ${type === t.value ? 'selection-active' : ''}`}
                  style={type === t.value
                    ? { background: 'var(--m3-primary-fixed)', color: 'var(--m3-primary)', border: '1px solid color-mix(in srgb, var(--m3-primary) 25%, transparent)' }
                    : { color: 'var(--m3-secondary)', border: '1px solid transparent' }
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <Field label="Interval (s)">
            <input type="number" value={intervalSecs} onChange={(e) => setIntervalSecs(Number(e.target.value))} min={10} className="input-sig" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Timeout (ms)">
              <input type="number" value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} min={1000} className="input-sig" />
            </Field>
            <Field label="Attempts">
              <input type="number" value={retries} onChange={(e) => setRetries(Math.max(1, Number(e.target.value)))} min={1} max={10} className="input-sig" />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Alert after (checks)">
              <input type="number" value={failureThreshold} onChange={(e) => setFailureThreshold(Math.max(1, Number(e.target.value)))} min={1} max={20} className="input-sig" />
            </Field>
            <Field label="Recover after (checks)">
              <input type="number" value={recoveryThreshold} onChange={(e) => setRecoveryThreshold(Math.max(1, Number(e.target.value)))} min={1} max={20} className="input-sig" />
            </Field>
          </div>
          <p className="text-xs -mt-2" style={{ color: 'var(--m3-secondary)' }}>
            Consecutive checks required before a notification is sent. Raise the first value to stop a flapping
            endpoint from paging on every blip — the status page still updates immediately. 1 = notify on every change.
          </p>

          <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

          <MonitorTypeConfigFields
            type={type}
            config={config}
            updateConfig={updateConfig}
            vaultPicker={vaultPicker}
            webhook={{ token: webhookToken, canReset: isEdit, resetting: resettingToken, onReset: handleResetToken }}
          />

          {/* ── Test result panel ─────────────────────────────────────────── */}
          {testResult && <TestResultPanel result={testResult} />}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg transition-colors"
              style={{ color: 'var(--m3-secondary)' }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-on-surface)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-secondary)')}
            >
              {webhookCreated ? 'Close' : 'Cancel'}
            </button>
            {isTestable && (
              <button type="button" onClick={handleTest} disabled={testing || loading}
                className="px-4 py-2 text-sm font-semibold rounded-lg transition-all flex items-center gap-1.5"
                style={{
                  background: 'var(--m3-surface-container-high)',
                  color: testing ? 'var(--m3-secondary)' : 'var(--m3-on-surface)',
                  opacity: testing ? 0.7 : 1,
                  border: '1px solid var(--m3-outline-variant)',
                }}
              >
                {testing
                  ? <><span className="material-symbols-outlined animate-spin" style={{ fontSize: '15px' }}>progress_activity</span> Testing…</>
                  : <><span className="material-symbols-outlined" style={{ fontSize: '15px' }}>play_arrow</span> Test</>
                }
              </button>
            )}
            <button type="submit" disabled={loading}
              className="btn-primary px-4 py-2 text-sm font-semibold rounded-lg transition-all"
              style={{
                background: loading ? 'var(--m3-surface-container-high)' : 'var(--m3-primary)',
                color:      loading ? 'var(--m3-secondary)' : 'var(--m3-on-primary)',
                opacity: loading ? 0.7 : 1,
              }}
            >
              {loading ? 'Saving…' : webhookCreated ? 'Done' : isEdit ? 'Save Changes' : 'Create Monitor'}
            </button>
          </div>
        </form>
      </div>{/* inner scrollable column */}

      {/* ── Side panel ─────────────────────────────────────────────────── */}
      {sidePanel && (
        <SidePanelFrame meta={PANEL_META[sidePanel]}>
          {sidePanel === 'request' && <RequestSection config={config} updateConfig={updateConfig} />}
          {sidePanel === 'auth' && <AuthSection auth={auth} onChange={(next) => updateConfig('auth', next)} vaultPicker={vaultPicker} />}
          {sidePanel === 'tags' && <TagsSection tags={tags} allTags={allTags} onChange={setTags} />}
          {sidePanel === 'channels' && <ChannelsSection channels={channels} selected={selectedChannelIds} onChange={setSelectedChannelIds} />}
          {sidePanel === 'dependencies' && (
            <DependenciesSection
              monitors={allMonitors.filter((m) => m.id !== monitor?.id)}
              selected={selectedDependsOnIds}
              onChange={setSelectedDependsOnIds}
            />
          )}
        </SidePanelFrame>
      )}

      {/* ── Vertical tab strip ──────────────────────────────────────────── */}
      <SideTabStrip tabs={sideTabs} meta={PANEL_META} active={sidePanel} onToggle={setSidePanel} />

      </div>{/* outer flex row */}
    </ModalShell>
  )
}
