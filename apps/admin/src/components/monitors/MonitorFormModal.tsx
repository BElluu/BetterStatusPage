import { useState, useEffect } from 'react'
import { api } from '../../api/client'
import type { Monitor, MonitorType, NotificationChannel, MonitorTag } from '@bsp/shared'
import { ModalHeader, ModalShell } from '../ModalShell'
import { AuthSection, readAuth } from './AuthSection'
import { SidePanelFrame, SideTabStrip, type SideTab } from '../SidePanel'
import { ChannelsSection, DependenciesSection, PANEL_META, RequestSection, type SidePanelKey } from './MonitorSidePanel'
import { MonitorTypeConfigFields } from './MonitorTypeConfigFields'
import { Field, type SecretSummary, type VaultSummary } from './monitorFormParts'
import { DATABASE_DEFAULT_PORTS, DATABASE_DEFAULT_QUERIES, isDatabaseType } from './monitorTypes'
import { MonitorTypePicker } from './MonitorTypePicker'
import { ScheduleSection } from './ScheduleSection'
import { TagsSection } from './TagsSection'
import { TestResultPanel, type TestResult } from './TestResultPanel'
import { Alert } from '../ui'

interface Props {
  monitor: Monitor | null
  /** Type preselected when creating a monitor; ignored when editing. */
  initialType?: MonitorType | undefined
  allTags?: MonitorTag[]
  onClose: () => void
  onSaved: () => void
}

const defaultConfigs: Record<MonitorType, Record<string, unknown>> = {
  https:     { url: 'https://', method: 'GET', expectedStatus: 200 },
  ping:      { host: '', mode: 'tcp', port: 80 },
  dns:       { hostname: '', recordType: 'A' },
  sqlserver: { host: '', port: 1433, database: '', user: '', password: '', query: 'SELECT 1' },
  postgresql: { host: '', port: 5432, database: '', user: '', password: '', query: 'SELECT 1' },
  mysql:     { host: '', port: 3306, database: '', user: '', password: '', query: 'SELECT 1' },
  mongodb:   { host: '', port: 27017, database: '', user: '', password: '', query: '{"ping":1}' },
  docker:    { endpoint: 'unix:///var/run/docker.sock', container: '' },
  webhook:   {},
}

export default function MonitorFormModal({ monitor, initialType = 'https', allTags = [], onClose, onSaved }: Props) {
  const isEdit = !!monitor
  const [name, setName]               = useState(monitor?.name ?? '')
  const [key, setKey]                 = useState(monitor?.key ?? '')
  const [type, setType]               = useState<MonitorType>(monitor?.type as MonitorType ?? initialType)
  const [intervalSecs, setIntervalSecs] = useState(monitor?.intervalSecs ?? 60)
  const [timeoutMs, setTimeoutMs]     = useState(monitor?.timeoutMs ?? 10000)
  const [config, setConfig]           = useState<Record<string, unknown>>(
    monitor ? (monitor.config as unknown as Record<string, unknown>) : (defaultConfigs[initialType] as Record<string, unknown>),
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

  /** Switches the engine of a Database monitor, keeping what was typed; only a default port and test query follow the engine. */
  function handleEngineChange(engine: MonitorType) {
    const oldPort = DATABASE_DEFAULT_PORTS[type]
    const oldQuery = DATABASE_DEFAULT_QUERIES[type]
    setType(engine)
    setConfig((prev) => ({
      ...prev,
      ...(prev['port'] === oldPort ? { port: DATABASE_DEFAULT_PORTS[engine] } : {}),
      ...(prev['query'] === oldQuery ? { query: DATABASE_DEFAULT_QUERIES[engine] } : {}),
    }))
  }

  function updateConfig(key: string, value: unknown) {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }

  /** Errors propagate so the webhook section can show why the token was not rotated. */
  async function handleResetToken() {
    if (!monitor) return
    setResettingToken(true)
    try {
      const updated = await api.post<{ webhookToken: string }>(`/admin/monitors/${monitor.id}/reset-token`, {})
      setWebhookToken(updated.webhookToken)
    } finally {
      setResettingToken(false)
    }
  }

  async function handleTest() {
    if (type !== 'https' && !isDatabaseType(type) && type !== 'ping' && type !== 'dns' && type !== 'docker') return
    setTesting(true)
    setTestResult(null)
    try {
      // monitorId lets the server test with the stored value of a secret the form only shows masked.
      const result = await api.post<TestResult>('/admin/monitors/test', { type, config, timeoutMs, ...(isEdit ? { monitorId: monitor.id } : {}) })
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
      const body = { name, ...(key.trim() ? { key: key.trim() } : {}), type, intervalSecs, timeoutMs, retries, failureThreshold, recoveryThreshold, config, tags }
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
  const isTestable = type === 'https' || isDatabaseType(type) || type === 'ping' || type === 'dns' || type === 'docker'
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
    <ModalShell align="top" onClose={onClose} label={isEdit ? 'Edit Monitor' : 'New Monitor'}>
      <div
        className="rounded-2xl my-8 flex flex-col lg:flex-row"
        style={{
          width: sidePanel ? 'min(1024px, calc(100vw - 32px))' : 'min(604px, calc(100vw - 32px))',
          background: 'var(--m3-surface-container-low)',
          border: '1px solid var(--m3-outline-variant)',
          transition: 'width 0.2s ease',
        }}
      >
      <div className={`flex-none min-w-0 w-full ${sidePanel ? 'lg:w-[560px]' : 'lg:w-[calc(100%-44px)]'}`}>
        {/* Header */}
        <ModalHeader icon="radio_button_checked" title={isEdit ? 'Edit Monitor' : 'New Monitor'} onClose={onClose} />

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <Alert tone="error">{error}</Alert>}

          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} required className="input-sig" placeholder="My Service" />
          </Field>

          <Field label="Key" hint="Stable identifier for the API and config files. Lowercase letters, digits, - and _. Generated from the name when empty.">
            <input value={key} onChange={(e) => setKey(e.target.value)} className="input-sig" placeholder="my-service" maxLength={64} />
          </Field>

          <MonitorTypePicker value={type} onChange={handleTypeChange} />

          <MonitorTypeConfigFields
            type={type}
            config={config}
            updateConfig={updateConfig}
            onEngineChange={handleEngineChange}
            vaultPicker={vaultPicker}
            webhook={{ token: webhookToken, canReset: isEdit, resetting: resettingToken, onReset: handleResetToken }}
          />

          <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

          <ScheduleSection
            values={{ intervalSecs, timeoutMs, retries, failureThreshold, recoveryThreshold }}
            onChange={(p) => {
              if (p.intervalSecs !== undefined) setIntervalSecs(p.intervalSecs)
              if (p.timeoutMs !== undefined) setTimeoutMs(p.timeoutMs)
              if (p.retries !== undefined) setRetries(p.retries)
              if (p.failureThreshold !== undefined) setFailureThreshold(p.failureThreshold)
              if (p.recoveryThreshold !== undefined) setRecoveryThreshold(p.recoveryThreshold)
            }}
          />

          {/* ── Test result panel ─────────────────────────────────────────── */}
          {testResult && <TestResultPanel result={testResult} />}

          <div className="flex flex-wrap justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              {webhookCreated ? 'Close' : 'Cancel'}
            </button>
            {isTestable && (
              <button type="button" onClick={handleTest} disabled={testing || loading} className="btn btn-outline">
                {testing
                  ? <><span className="material-symbols-outlined animate-spin" aria-hidden="true">progress_activity</span> Testing…</>
                  : <><span className="material-symbols-outlined" aria-hidden="true">play_arrow</span> Test</>
                }
              </button>
            )}
            <button type="submit" disabled={loading} className="btn btn-primary">
              {loading ? 'Saving…' : webhookCreated ? 'Done' : isEdit ? 'Save Changes' : 'Create Monitor'}
            </button>
          </div>
        </form>
      </div>{/* inner scrollable column */}

      {/* ── Side panel ─────────────────────────────────────────────────── */}
      {sidePanel && (
        <SidePanelFrame meta={PANEL_META[sidePanel]} layout="responsive">
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
      <SideTabStrip tabs={sideTabs} meta={PANEL_META} active={sidePanel} onToggle={setSidePanel} layout="responsive" />

      </div>{/* outer flex row */}
    </ModalShell>
  )
}
