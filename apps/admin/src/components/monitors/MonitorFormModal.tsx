import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api/client'
import type { Monitor, MonitorType, HttpsAuth, HttpsAuthType, VaultRef, NotificationChannel, MonitorTag } from '@bsp/shared'

interface TestStep   { label: string; status: 'ok' | 'error' | 'info'; detail?: string; cookies?: Record<string, string>; durationMs?: number }
interface TestResult { overall: 'ok' | 'error'; steps: TestStep[]; totalMs: number }

interface Props {
  monitor: Monitor | null
  allTags?: MonitorTag[]
  onClose: () => void
  onSaved: () => void
}

interface VaultSummary  { id: number; name: string }
interface SecretSummary { id: number; name: string; type: 'userpass' | 'value' | 'json' }

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

const AUTH_TYPES: { value: HttpsAuthType; label: string }[] = [
  { value: 'none',   label: 'None' },
  { value: 'basic',  label: 'Basic' },
  { value: 'oauth2', label: 'OAuth2' },
  { value: 'cas',    label: 'CAS' },
]

// Fields that can be sourced from a json vault secret, per context
const JSON_MAPPING_FIELDS: Record<string, { key: string; label: string }[]> = {
  basic:     [{ key: 'username', label: 'Username' }, { key: 'password', label: 'Password' }],
  oauth2:    [{ key: 'clientId', label: 'Client ID' }, { key: 'clientSecret', label: 'Client Secret' }],
  cas:       [{ key: 'username', label: 'Username' }, { key: 'password', label: 'Password' }],
  sqlserver: [{ key: 'username', label: 'Username' }, { key: 'password', label: 'Password' }],
}

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
  const [tags, setTags]                 = useState<MonitorTag[]>(monitor?.tags ?? [])
  const [sidePanel, setSidePanel] = useState<'request' | 'auth' | 'tags' | 'channels' | 'dependencies' | null>(null)
  const [webhookToken, setWebhookToken] = useState<string | null>(monitor?.webhookToken ?? null)
  const [resettingToken, setResettingToken] = useState(false)
  const [copied, setCopied]             = useState(false)
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

  function webhookUrl(token: string) {
    return `${window.location.origin}/api/v1/hook/${token}`
  }

  async function handleCopyUrl() {
    if (!webhookToken) return
    await navigator.clipboard.writeText(webhookUrl(webhookToken))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
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
      const body = { name, type, intervalSecs, timeoutMs, retries, config, tags }
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

  // ── HTTPS auth helpers ────────────────────────────────────────────────────
  const auth     = (config['auth'] as HttpsAuth | undefined) ?? { type: 'none' as HttpsAuthType }
  const authType = auth.type ?? 'none'

  function setAuthType(t: HttpsAuthType) { updateConfig('auth', { ...auth, type: t }) }
  function updateBasic(patch: Record<string, unknown>)  { updateConfig('auth', { ...auth, basic:  { ...(auth.basic  ?? {}), ...patch } }) }
  function updateOAuth2(patch: Record<string, unknown>) { updateConfig('auth', { ...auth, oauth2: { ...(auth.oauth2 ?? {}), ...patch } }) }
  function updateCAS(patch: Record<string, unknown>)    { updateConfig('auth', { ...auth, cas:    { ...(auth.cas    ?? {}), ...patch } }) }

  const basicVault  = (auth.basic  as Record<string, unknown> | undefined)?.['vault']  as VaultRef | undefined
  const oauth2Vault = (auth.oauth2 as Record<string, unknown> | undefined)?.['vault']  as VaultRef | undefined
  const casVault    = (auth.cas    as Record<string, unknown> | undefined)?.['vault']  as VaultRef | undefined
  const sqlVault    = config['vault'] as VaultRef | undefined

  // ── Shared props ─────────────────────────────────────────────────────────
  const vaultPickerProps = { vaults, secretsByVault, onLoadSecrets: loadSecrets }

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
    const rows = headerRows.filter((_, i) => i !== idx)
    updateConfig('headers', Object.fromEntries(rows))
  }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.55)', overflowY: 'auto' }}>
      <div style={{ display: 'flex', minHeight: '100%', alignItems: 'flex-start', justifyContent: 'center', padding: '16px' }}>
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

          <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

          {/* ── HTTPS ──────────────────────────────────────────────────────── */}
          {type === 'https' && (
            <>
              <Field label="URL">
                <input value={(config['url'] as string) ?? ''} onChange={(e) => updateConfig('url', e.target.value)} required className="input-sig" placeholder="https://example.com" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Method">
                  <select value={(config['method'] as string) ?? 'GET'} onChange={(e) => updateConfig('method', e.target.value)} className="input-sig">
                    <option>GET</option><option>POST</option><option>HEAD</option>
                  </select>
                </Field>
                <Field label="Expected Status">
                  <input type="number" value={(config['expectedStatus'] as number) ?? 200} onChange={(e) => updateConfig('expectedStatus', Number(e.target.value))} className="input-sig" />
                </Field>
              </div>
              <Field label="Keyword (optional)">
                <input value={(config['keyword'] as string) ?? ''} onChange={(e) => updateConfig('keyword', e.target.value)} className="input-sig" placeholder="must contain…" />
              </Field>

            </>
          )}

          {/* ── Ping ───────────────────────────────────────────────────────── */}
          {type === 'ping' && (
            <>
              <Field label="Host">
                <input value={(config['host'] as string) ?? ''} onChange={(e) => updateConfig('host', e.target.value)} required className="input-sig" placeholder="192.168.1.1" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Mode">
                  <select value={(config['mode'] as string) ?? 'tcp'} onChange={(e) => updateConfig('mode', e.target.value)} className="input-sig">
                    <option value="tcp">TCP</option>
                    <option value="icmp">ICMP</option>
                  </select>
                </Field>
                <Field label="Port">
                  <input type="number" value={(config['port'] as number) ?? 80} onChange={(e) => updateConfig('port', Number(e.target.value))} className="input-sig" />
                </Field>
              </div>
            </>
          )}

          {/* ── DNS ────────────────────────────────────────────────────────── */}
          {type === 'dns' && (
            <>
              <Field label="Hostname">
                <input value={(config['hostname'] as string) ?? ''} onChange={(e) => updateConfig('hostname', e.target.value)} required className="input-sig" placeholder="example.com" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Record Type">
                  <select value={(config['recordType'] as string) ?? 'A'} onChange={(e) => updateConfig('recordType', e.target.value)} className="input-sig">
                    <option>A</option><option>AAAA</option><option>MX</option><option>CNAME</option><option>TXT</option>
                  </select>
                </Field>
                <Field label="Expected Value">
                  <input value={(config['expectedValue'] as string) ?? ''} onChange={(e) => updateConfig('expectedValue', e.target.value)} className="input-sig" placeholder="1.2.3.4" />
                </Field>
              </div>
              <Field label="Custom Resolver (optional)">
                <input value={(config['resolver'] as string) ?? ''} onChange={(e) => updateConfig('resolver', e.target.value)} className="input-sig" placeholder="8.8.8.8" />
              </Field>
            </>
          )}

          {/* ── SQL Server ─────────────────────────────────────────────────── */}
          {type === 'sqlserver' && (() => {
            const sqlMode = (config['mode'] as string) ?? 'fields'
            return (
              <>
                {/* Connection mode toggle */}
                <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--m3-outline-variant)', width: 'fit-content' }}>
                  {(['fields', 'connectionString'] as const).map((m) => (
                    <button key={m} type="button"
                      onClick={() => { updateConfig('mode', m); updateConfig('vault', undefined) }}
                      className={`px-4 py-1.5 text-xs font-medium transition-all ${sqlMode === m ? 'selection-active' : ''}`}
                      style={{
                        background: sqlMode === m ? 'var(--m3-primary-fixed)' : 'transparent',
                        color:      sqlMode === m ? 'var(--m3-primary)' : 'var(--m3-secondary)',
                      }}
                    >
                      {m === 'fields' ? 'Individual fields' : 'Connection string'}
                    </button>
                  ))}
                </div>

                {sqlMode === 'fields' && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Host">
                        <input value={(config['host'] as string) ?? ''} onChange={(e) => updateConfig('host', e.target.value)} required className="input-sig" placeholder="localhost" />
                      </Field>
                      <Field label="Port">
                        <input type="number" value={(config['port'] as number) ?? 1433} onChange={(e) => updateConfig('port', Number(e.target.value))} className="input-sig" />
                      </Field>
                    </div>
                    <Field label="Database">
                      <input value={(config['database'] as string) ?? ''} onChange={(e) => updateConfig('database', e.target.value)} required className="input-sig" />
                    </Field>
                    <SectionDivider label="Credentials" />
                    <CredentialSection
                      {...vaultPickerProps}
                      vault={sqlVault}
                      onVaultChange={(v) => updateConfig('vault', v)}
                      mappingFields={JSON_MAPPING_FIELDS['sqlserver']!}
                    >
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="User">
                          <input value={(config['user'] as string) ?? ''} onChange={(e) => updateConfig('user', e.target.value)} required className="input-sig" autoComplete="off" />
                        </Field>
                        <Field label="Password">
                          <input type="password" value={(config['password'] as string) ?? ''} onChange={(e) => updateConfig('password', e.target.value)} required className="input-sig" autoComplete="new-password" />
                        </Field>
                      </div>
                    </CredentialSection>
                  </>
                )}

                {sqlMode === 'connectionString' && (
                  <ConnectionStringSection
                    {...vaultPickerProps}
                    vault={sqlVault}
                    onVaultChange={(v) => updateConfig('vault', v)}
                  />
                )}

                <Field label="Test Query">
                  <input value={(config['query'] as string) ?? 'SELECT 1'} onChange={(e) => updateConfig('query', e.target.value)} className="input-sig" />
                </Field>
              </>
            )
          })()}

          {/* ── Webhook ────────────────────────────────────────────────────── */}
          {type === 'webhook' && (
            <div className="space-y-3">
              <div
                className="flex items-start gap-2 rounded-lg px-3 py-2"
                style={{ background: 'rgba(57,128,244,0.08)', border: '1px solid rgba(57,128,244,0.20)' }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '16px', color: '#3980f4', lineHeight: '20px' }}>info</span>
                <p className="text-xs" style={{ color: 'var(--m3-on-surface-variant)' }}>
                  The monitor goes <strong>up</strong> when an external service sends a request to the webhook URL, and goes <strong>down</strong> if no request is received within the configured interval.
                </p>
              </div>

              {webhookToken ? (
                <>
                  <Field label="Webhook URL">
                    <div className="flex gap-2 items-stretch">
                      <input
                        readOnly
                        className="input-sig flex-1 font-mono text-xs"
                        value={webhookUrl(webhookToken)}
                      />
                      <button
                        type="button"
                        onClick={handleCopyUrl}
                        className="flex items-center gap-1 px-3 rounded-lg text-xs font-semibold transition-all flex-shrink-0"
                        style={{
                          background: copied ? 'var(--m3-primary-fixed)' : 'var(--m3-surface-container-high)',
                          color: copied ? 'var(--m3-primary)' : 'var(--m3-on-surface)',
                          border: '1px solid var(--m3-outline-variant)',
                        }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
                          {copied ? 'check' : 'content_copy'}
                        </span>
                        {copied ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </Field>
                  {isEdit && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={handleResetToken}
                        disabled={resettingToken}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors"
                        style={{
                          color: 'var(--m3-secondary)',
                          background: 'var(--m3-surface-container)',
                          border: '1px solid var(--m3-outline-variant)',
                          opacity: resettingToken ? 0.6 : 1,
                        }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>refresh</span>
                        {resettingToken ? 'Resetting…' : 'Reset token'}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
                  A unique webhook URL will be generated after saving.
                </p>
              )}
            </div>
          )}

          {/* ── Test result panel ─────────────────────────────────────────── */}
          {testResult && <TestResultPanel result={testResult} />}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg transition-colors"
              style={{ color: 'var(--m3-secondary)' }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-on-surface)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-secondary)')}
            >
              {(type === 'webhook' && !isEdit && webhookToken) ? 'Close' : 'Cancel'}
            </button>
            {(type === 'https' || type === 'sqlserver' || type === 'ping' || type === 'dns') && (
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
              {loading ? 'Saving…' : (type === 'webhook' && !isEdit && webhookToken) ? 'Done' : isEdit ? 'Save Changes' : 'Create Monitor'}
            </button>
          </div>
        </form>
      </div>{/* inner scrollable column */}

      {/* ── Side panel ─────────────────────────────────────────────────── */}
      {sidePanel && (() => {
        const PANEL_LABELS: Record<string, { icon: string; label: string }> = {
          auth:         { icon: 'lock',          label: 'Auth' },
          request:      { icon: 'tune',          label: 'Request' },
          tags:         { icon: 'label',         label: 'Tags' },
          channels:     { icon: 'notifications', label: 'Alerts' },
          dependencies: { icon: 'account_tree',  label: 'Depends on' },
        }
        const current = PANEL_LABELS[sidePanel]!
        return (
          <div style={{ flex: 1, minWidth: '360px', borderLeft: '1px solid var(--m3-outline-variant)', display: 'flex', flexDirection: 'column' }}>
            {/* Panel header — just the section title */}
            <div className="flex items-center gap-2 px-5 py-4" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
              <span className="material-symbols-outlined" style={{ fontSize: '16px', color: 'var(--m3-primary)' }}>{current.icon}</span>
              <span className="font-mono text-xs uppercase tracking-wider font-medium" style={{ color: 'var(--m3-on-surface)', flex: 1 }}>{current.label}</span>
            </div>

            {/* Tab content */}
            <div className="p-5 space-y-4 overflow-y-auto" style={{ flex: 1 }}>

              {/* ── Request (Headers & Body) ── */}
              {sidePanel === 'request' && (
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
              )}

              {/* ── Auth ── */}
              {sidePanel === 'auth' && (
                <div className="space-y-4">
                  <div className="flex rounded-lg p-1 gap-1" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
                    {AUTH_TYPES.map((at) => (
                      <button key={at.value} type="button" onClick={() => setAuthType(at.value)}
                        className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-all ${authType === at.value ? 'selection-active' : ''}`}
                        style={authType === at.value
                          ? { background: 'var(--m3-primary-fixed)', color: 'var(--m3-primary)', border: '1px solid color-mix(in srgb, var(--m3-primary) 25%, transparent)' }
                          : { color: 'var(--m3-secondary)', border: '1px solid transparent' }
                        }
                      >
                        {at.label}
                      </button>
                    ))}
                  </div>

                  {authType === 'none' && (
                    <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No authentication configured.</p>
                  )}

                  {authType === 'basic' && (
                    <CredentialSection {...vaultPickerProps} vault={basicVault} onVaultChange={(v) => updateBasic({ vault: v })} mappingFields={JSON_MAPPING_FIELDS['basic']!}>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Username"><input value={(auth.basic as Record<string, unknown> | undefined)?.['username'] as string ?? ''} onChange={(e) => updateBasic({ username: e.target.value })} className="input-sig" autoComplete="off" /></Field>
                        <Field label="Password"><input type="password" value={(auth.basic as Record<string, unknown> | undefined)?.['password'] as string ?? ''} onChange={(e) => updateBasic({ password: e.target.value })} className="input-sig" autoComplete="new-password" /></Field>
                      </div>
                    </CredentialSection>
                  )}

                  {authType === 'oauth2' && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Token URL"><input value={(auth.oauth2 as Record<string, unknown> | undefined)?.['tokenUrl'] as string ?? ''} onChange={(e) => updateOAuth2({ tokenUrl: e.target.value })} className="input-sig" placeholder="https://auth.example.com/oauth/token" /></Field>
                        <Field label="Scope (optional)"><input value={(auth.oauth2 as Record<string, unknown> | undefined)?.['scope'] as string ?? ''} onChange={(e) => updateOAuth2({ scope: e.target.value })} className="input-sig" placeholder="read write" /></Field>
                      </div>
                      <CredentialSection {...vaultPickerProps} vault={oauth2Vault} onVaultChange={(v) => updateOAuth2({ vault: v })} mappingFields={JSON_MAPPING_FIELDS['oauth2']!}>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label="Client ID"><input value={(auth.oauth2 as Record<string, unknown> | undefined)?.['clientId'] as string ?? ''} onChange={(e) => updateOAuth2({ clientId: e.target.value })} className="input-sig" autoComplete="off" /></Field>
                          <Field label="Client Secret"><input type="password" value={(auth.oauth2 as Record<string, unknown> | undefined)?.['clientSecret'] as string ?? ''} onChange={(e) => updateOAuth2({ clientSecret: e.target.value })} className="input-sig" autoComplete="new-password" /></Field>
                        </div>
                      </CredentialSection>
                    </>
                  )}

                  {authType === 'cas' && (
                    <>
                      <Field label="CAS Server URL"><input value={(auth.cas as Record<string, unknown> | undefined)?.['casServerUrl'] as string ?? ''} onChange={(e) => updateCAS({ casServerUrl: e.target.value })} className="input-sig" placeholder="https://cas.example.com/cas" /></Field>
                      <CredentialSection {...vaultPickerProps} vault={casVault} onVaultChange={(v) => updateCAS({ vault: v })} mappingFields={JSON_MAPPING_FIELDS['cas']!}>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label="Username"><input value={(auth.cas as Record<string, unknown> | undefined)?.['username'] as string ?? ''} onChange={(e) => updateCAS({ username: e.target.value })} className="input-sig" autoComplete="off" /></Field>
                          <Field label="Password"><input type="password" value={(auth.cas as Record<string, unknown> | undefined)?.['password'] as string ?? ''} onChange={(e) => updateCAS({ password: e.target.value })} className="input-sig" autoComplete="new-password" /></Field>
                        </div>
                      </CredentialSection>
                    </>
                  )}
                </div>
              )}

              {/* ── Tags ── */}
              {sidePanel === 'tags' && (
                <div className="space-y-3">
                  {tags.length === 0 && <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No tags yet.</p>}
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {tags.map((t, i) => (
                        <span key={i} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium"
                          style={{ background: `${t.color}22`, color: t.color, border: `1px solid ${t.color}55` }}>
                          {t.label}
                          <button type="button" onClick={() => setTags(tags.filter((_, j) => j !== i))} className="leading-none opacity-60 hover:opacity-100">×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <AddTagRow
                    existingTags={allTags.filter((t) => !tags.find((cur) => cur.label === t.label))}
                    onAdd={(tag) => { if (!tags.find((t) => t.label === tag.label)) setTags([...tags, tag]) }}
                  />
                </div>
              )}

              {/* ── Channels ── */}
              {sidePanel === 'channels' && (
                <div className="space-y-2">
                  {channels.length === 0 && (
                    <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No notification channels configured. Create one in the Notifications section.</p>
                  )}
                  {channels.map((ch) => (
                    <label key={ch.id} className="flex items-center gap-3 cursor-pointer select-none rounded-lg px-3 py-2 transition-colors"
                      style={{ border: '1px solid var(--m3-outline-variant)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--m3-surface-container)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                    >
                      <input type="checkbox" checked={selectedChannelIds.has(ch.id)}
                        onChange={(e) => { setSelectedChannelIds((prev) => { const next = new Set(prev); if (e.target.checked) next.add(ch.id); else next.delete(ch.id); return next }) }}
                        className="w-4 h-4 rounded accent-[color:var(--m3-primary)]"
                      />
                      <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: '16px', color: ch.type === 'email' ? '#6366f1' : '#10b981' }}>
                        {ch.type === 'email' ? 'mail' : 'webhook'}
                      </span>
                      <span className="text-sm flex-1" style={{ color: 'var(--m3-on-surface)' }}>{ch.name}</span>
                      {!ch.enabled && <span className="text-xs" style={{ color: 'var(--m3-secondary)' }}>disabled</span>}
                    </label>
                  ))}
                </div>
              )}

              {/* ── Dependencies ── */}
              {sidePanel === 'dependencies' && (
                <div className="space-y-3">
                  <div
                    className="flex items-start gap-2 rounded-lg px-3 py-2"
                    style={{ background: 'rgba(57,128,244,0.08)', border: '1px solid rgba(57,128,244,0.20)' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '16px', color: '#3980f4', lineHeight: '20px' }}>info</span>
                    <p className="text-xs" style={{ color: 'var(--m3-on-surface-variant)' }}>
                      If a selected dependency goes <strong>down</strong>, this monitor will show <strong>Affected</strong> instead of Down — suppressing duplicate alerts for the same root cause.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    {allMonitors.filter((m) => m.id !== monitor?.id).length === 0 && (
                      <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No other monitors available.</p>
                    )}
                    {allMonitors
                      .filter((m) => m.id !== monitor?.id)
                      .map((m) => (
                        <label key={m.id} className="flex items-center gap-3 cursor-pointer select-none rounded-lg px-3 py-2 transition-colors"
                          style={{ border: '1px solid var(--m3-outline-variant)' }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--m3-surface-container)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                        >
                          <input type="checkbox" checked={selectedDependsOnIds.has(m.id)}
                            onChange={(e) => { setSelectedDependsOnIds((prev) => { const next = new Set(prev); if (e.target.checked) next.add(m.id); else next.delete(m.id); return next }) }}
                            className="w-4 h-4 rounded accent-[color:var(--m3-primary)]"
                          />
                          <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: '16px', color: 'var(--m3-secondary)' }}>monitor_heart</span>
                          <span className="text-sm flex-1" style={{ color: 'var(--m3-on-surface)' }}>{m.name}</span>
                        </label>
                      ))
                    }
                  </div>
                </div>
              )}

            </div>
          </div>
        )
      })()}

      {/* ── Vertical tab strip ──────────────────────────────────────────── */}
      {(() => {
        const tabs = [
          ...(type === 'https' ? [
            { key: 'auth' as const,     icon: 'lock',          label: 'Auth',    badge: authType !== 'none' ? authType.slice(0, 1).toUpperCase() : null },
            { key: 'request' as const,  icon: 'tune',          label: 'Request', badge: headerRows.length > 0 ? String(headerRows.length) : null },
          ] : []),
          { key: 'tags' as const,         icon: 'label',         label: 'Tags',     badge: tags.length > 0 ? String(tags.length) : null },
          { key: 'channels' as const,     icon: 'notifications', label: 'Alerts',   badge: selectedChannelIds.size > 0 ? String(selectedChannelIds.size) : null },
          { key: 'dependencies' as const, icon: 'account_tree',  label: 'Depends on', badge: selectedDependsOnIds.size > 0 ? String(selectedDependsOnIds.size) : null },
        ]
        return (
          <div style={{ flex: '0 0 44px', borderLeft: '1px solid var(--m3-outline-variant)', display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
            {tabs.map((tab) => {
              const active = sidePanel === tab.key
              return (
                <button key={tab.key} type="button"
                  title={tab.label}
                  onClick={() => setSidePanel(active ? null : tab.key)}
                  className={`relative flex flex-col items-center justify-center py-4 transition-all ${active ? 'monitor-side-tab-active' : ''}`}
                  style={{ color: active ? 'var(--m3-primary)' : 'var(--m3-secondary)', background: active ? 'var(--m3-primary-fixed)' : 'transparent', borderBottom: '1px solid var(--m3-outline-variant)' }}
                  onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-surface-container)' }}
                  onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = '' }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>{tab.icon}</span>
                  {tab.badge && (
                    <span className={`absolute top-1.5 right-1 flex items-center justify-center rounded-full font-bold leading-none ${active ? 'monitor-side-tab-badge-active' : ''}`}
                      style={{ background: active ? 'var(--m3-primary)' : 'var(--m3-on-surface-variant)', color: active ? 'var(--m3-on-primary)' : 'var(--m3-surface)', minWidth: '14px', height: '14px', fontSize: '9px', padding: '0 2px' }}>
                      {tab.badge}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )
      })()}

      </div>{/* outer flex row */}
      </div>
    </div>,
    document.body,
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <div style={{ flex: 1, borderTop: '1px solid var(--m3-outline-variant)' }} />
      <span className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>{label}</span>
      <div style={{ flex: 1, borderTop: '1px solid var(--m3-outline-variant)' }} />
    </div>
  )
}

interface CredentialSectionProps {
  vault: VaultRef | undefined
  onVaultChange: (v: VaultRef | undefined) => void
  vaults: { id: number; name: string }[]
  secretsByVault: Record<number, { id: number; name: string; type: string }[]>
  onLoadSecrets: (vaultId: number) => Promise<void>
  mappingFields: { key: string; label: string }[]
  /** Optional note shown at the top of the vault/direct section */
  note?: string
  /** Direct-input fields — rendered only when not using vault */
  children: React.ReactNode
}

/**
 * Wraps a set of credential fields with a Direct / Vault source toggle.
 * In direct mode: shows a warning banner + the credential inputs (children).
 * In vault mode: shows vault → secret dropdowns + JSON field mapping if needed.
 */
function CredentialSection({
  vault, onVaultChange,
  vaults, secretsByVault, onLoadSecrets,
  mappingFields, note, children,
}: CredentialSectionProps) {
  const isVault = !!vault

  const selectedVaultId  = vault?.vaultId
  const selectedSecretId = vault?.secretId
  const fieldMapping     = vault?.fieldMapping ?? {}

  const secrets        = selectedVaultId ? (secretsByVault[selectedVaultId] ?? null) : null
  const selectedSecret = secrets?.find((s) => s.id === selectedSecretId)

  return (
    <div className="space-y-3">
      {note && (
        <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>{note}</p>
      )}

      {/* Source toggle */}
      <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--m3-outline-variant)', width: 'fit-content' }}>
        {(['direct', 'vault'] as const).map((src) => {
          const active = src === 'vault' ? isVault : !isVault
          return (
            <button
              key={src}
              type="button"
              onClick={() => {
                if (src === 'direct') {
                  onVaultChange(undefined)
                } else {
                  const first = vaults[0]
                  if (first) onLoadSecrets(first.id)
                  onVaultChange({ vaultId: first?.id ?? 0, secretId: 0, fieldMapping: {} })
                }
              }}
              className={`px-4 py-1.5 text-xs font-medium transition-all ${active ? 'selection-active' : ''}`}
              style={{
                background: active ? 'var(--m3-primary-fixed)' : 'transparent',
                color:      active ? 'var(--m3-primary)' : 'var(--m3-secondary)',
              }}
            >
              {src === 'direct' ? 'Direct input' : 'From Vault'}
            </button>
          )
        })}
      </div>

      {/* Direct input */}
      {!isVault && (
        <>
          <div
            className="flex items-start gap-2 rounded-lg px-3 py-2"
            style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.20)' }}
          >
            <span style={{ color: '#eab308', lineHeight: '20px' }}>⚠</span>
            <p className="text-xs" style={{ color: 'var(--m3-on-surface-variant)' }}>
              For security, store credentials in Vault rather than entering them directly here.
            </p>
          </div>
          {children}
        </>
      )}

      {/* Vault picker */}
      {isVault && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Vault">
              <select
                className="input-sig"
                value={selectedVaultId || ''}
                onChange={(e) => {
                  const id = Number(e.target.value)
                  onLoadSecrets(id)
                  onVaultChange({ vaultId: id, secretId: 0, fieldMapping: {} })
                }}
              >
                <option value="">— select vault —</option>
                {vaults.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </Field>
            <Field label="Secret">
              <select
                className="input-sig"
                value={selectedSecretId || ''}
                disabled={!selectedVaultId}
                onChange={(e) => {
                  onVaultChange({ vaultId: selectedVaultId!, secretId: Number(e.target.value), fieldMapping: {} })
                }}
              >
                <option value="">— select secret —</option>
                {(secrets ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.type})</option>
                ))}
              </select>
            </Field>
          </div>

          {/* userpass — auto-mapped, no input needed */}
          {selectedSecret?.type === 'userpass' && (
            <p className="text-xs rounded-lg px-3 py-2" style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }}>
              Auto-mapped: <strong>username</strong> → username field, <strong>password</strong> → password field.
            </p>
          )}

          {/* value — single value used as password / client secret */}
          {selectedSecret?.type === 'value' && (
            <p className="text-xs rounded-lg px-3 py-2" style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }}>
              The secret value will be used as the <strong>password / client secret</strong>.
            </p>
          )}

          {/* json — field mapping UI */}
          {selectedSecret?.type === 'json' && selectedSecretId && (
            <div>
              <p className="font-mono text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--m3-secondary)' }}>
                JSON Field Mapping
              </p>
              <p className="text-xs mb-3" style={{ color: 'var(--m3-secondary)' }}>
                For each credential, enter the key name from the JSON secret.
              </p>
              <div className="space-y-2">
                {mappingFields.map(({ key, label }) => (
                  <div key={key} className="grid items-center gap-3" style={{ gridTemplateColumns: '110px 1fr' }}>
                    <span className="text-xs font-medium truncate" style={{ color: 'var(--m3-on-surface-variant)' }}>{label}</span>
                    <input
                      className="input-sig text-xs"
                      placeholder={`JSON key (e.g. "${key}")`}
                      value={fieldMapping[key] ?? ''}
                      onChange={(e) => {
                        onVaultChange({
                          vaultId: selectedVaultId!,
                          secretId: selectedSecretId,
                          fieldMapping: { ...fieldMapping, [key]: e.target.value },
                        })
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {vaults.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
              No vaults found. Create one in the Vault section first.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

interface ConnectionStringSectionProps {
  vault: VaultRef | undefined
  onVaultChange: (v: VaultRef | undefined) => void
  vaults: { id: number; name: string }[]
  secretsByVault: Record<number, { id: number; name: string; type: string }[]>
  onLoadSecrets: (vaultId: number) => Promise<void>
}

/**
 * Vault-only picker for SQL Server connection strings.
 * Direct input is intentionally not available — a connection string contains credentials.
 */
function ConnectionStringSection({
  vault, onVaultChange, vaults, secretsByVault, onLoadSecrets,
}: ConnectionStringSectionProps) {
  const selectedVaultId  = vault?.vaultId
  const selectedSecretId = vault?.secretId
  const fieldMapping     = vault?.fieldMapping ?? {}

  const secrets        = selectedVaultId ? (secretsByVault[selectedVaultId] ?? null) : null
  const selectedSecret = secrets?.find((s) => s.id === selectedSecretId)

  return (
    <div className="space-y-3">
      <div
        className="flex items-start gap-2 rounded-lg px-3 py-2"
        style={{ background: 'rgba(57,128,244,0.08)', border: '1px solid rgba(57,128,244,0.20)' }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: '16px', color: '#3980f4', lineHeight: '20px' }}>info</span>
        <p className="text-xs" style={{ color: 'var(--m3-on-surface-variant)' }}>
          Connection strings contain credentials and must always be stored in Vault.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Vault">
          <select
            className="input-sig"
            value={selectedVaultId || ''}
            onChange={(e) => {
              const id = Number(e.target.value)
              onLoadSecrets(id)
              onVaultChange({ vaultId: id, secretId: 0, fieldMapping: {} })
            }}
          >
            <option value="">— select vault —</option>
            {vaults.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
        <Field label="Secret">
          <select
            className="input-sig"
            value={selectedSecretId || ''}
            disabled={!selectedVaultId}
            onChange={(e) => {
              onVaultChange({ vaultId: selectedVaultId!, secretId: Number(e.target.value), fieldMapping: {} })
            }}
          >
            <option value="">— select secret —</option>
            {(secrets ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.type})</option>
            ))}
          </select>
        </Field>
      </div>

      {selectedSecret?.type === 'value' && (
        <p className="text-xs rounded-lg px-3 py-2" style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }}>
          The secret value will be used as the full connection string.
        </p>
      )}

      {selectedSecret?.type === 'userpass' && (
        <div className="flex items-start gap-2 rounded-lg px-3 py-2" style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.20)' }}>
          <span style={{ color: '#eab308', lineHeight: '20px' }}>⚠</span>
          <p className="text-xs" style={{ color: 'var(--m3-on-surface-variant)' }}>
            A <strong>userpass</strong> secret cannot be used as a connection string. Use a <strong>value</strong> or <strong>json</strong> secret instead.
          </p>
        </div>
      )}

      {selectedSecret?.type === 'json' && selectedSecretId && (
        <div>
          <p className="font-mono text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--m3-secondary)' }}>JSON Field Mapping</p>
          <p className="text-xs mb-3" style={{ color: 'var(--m3-secondary)' }}>Enter the JSON key that holds the connection string.</p>
          <div className="grid items-center gap-3" style={{ gridTemplateColumns: '130px 1fr' }}>
            <span className="text-xs font-medium" style={{ color: 'var(--m3-on-surface-variant)' }}>Connection String</span>
            <input
              className="input-sig text-xs"
              placeholder='JSON key (e.g. "connectionString")'
              value={fieldMapping['connectionString'] ?? ''}
              onChange={(e) => {
                onVaultChange({
                  vaultId: selectedVaultId!,
                  secretId: selectedSecretId,
                  fieldMapping: { connectionString: e.target.value },
                })
              }}
            />
          </div>
        </div>
      )}

      {vaults.length === 0 && (
        <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
          No vaults found. Create one in the Vault section first.
        </p>
      )}
    </div>
  )
}

// ── Test result panel ─────────────────────────────────────────────────────────

function buildTestReport(result: TestResult): string {
  const icon = (s: TestStep['status']) => s === 'ok' ? '✓' : s === 'error' ? '✗' : 'i'
  const sep = '─'.repeat(60)
  const lines: string[] = [
    'BSP Monitor Test Report',
    `Date:   ${new Date().toISOString()}`,
    `Result: ${result.overall === 'ok' ? 'PASSED' : 'FAILED'}  |  Total: ${result.totalMs}ms`,
    sep,
    '',
  ]
  for (const step of result.steps) {
    const dur = step.durationMs != null ? `  (${step.durationMs}ms)` : ''
    lines.push(`[${icon(step.status)}] ${step.label}${dur}`)
    if (step.detail) {
      lines.push(`    ${step.detail}`)
    }
    if (step.cookies && Object.keys(step.cookies).length > 0) {
      lines.push('    Cookie jar:')
      for (const [name, value] of Object.entries(step.cookies)) {
        lines.push(`      ${name} = ${value}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

function TestResultPanel({ result }: { result: TestResult }) {
  const isOk = result.overall === 'ok'

  const handleDownload = () => {
    const text = buildTestReport(result)
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bsp-test-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${isOk ? 'rgba(34,197,94,0.3)' : 'rgba(186,26,26,0.25)'}` }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ background: isOk ? 'rgba(34,197,94,0.08)' : 'rgba(186,26,26,0.07)' }}
      >
        <div className="flex items-center gap-2">
          <span
            className="material-symbols-outlined"
            style={{ fontSize: '18px', color: isOk ? '#22c55e' : '#ba1a1a' }}
          >
            {isOk ? 'check_circle' : 'cancel'}
          </span>
          <span className="text-sm font-semibold" style={{ color: isOk ? '#22c55e' : '#ba1a1a' }}>
            {isOk ? 'All checks passed' : 'Test failed'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDownload}
            title="Download full test report"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-mono transition-colors"
            style={{
              color: 'var(--m3-secondary)',
              background: 'var(--m3-surface-container)',
              border: '1px solid var(--m3-outline-variant)',
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>download</span>
            report
          </button>
          <span className="text-xs font-mono" style={{ color: 'var(--m3-secondary)' }}>
            {result.totalMs}ms total
          </span>
        </div>
      </div>

      {/* Steps */}
      <div className="divide-y" style={{ borderColor: 'var(--m3-outline-variant)' }}>
        {result.steps.filter(s => s.status !== 'info').map((step, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-2.5" style={{ background: 'var(--m3-surface-container-lowest)' }}>
            <span
              className="material-symbols-outlined shrink-0"
              style={{
                fontSize: '16px',
                marginTop: '1px',
                color: step.status === 'ok' ? '#22c55e' : step.status === 'error' ? '#ba1a1a' : 'var(--m3-secondary)',
              }}
            >
              {step.status === 'ok' ? 'check_circle' : step.status === 'error' ? 'cancel' : 'info'}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate" style={{ color: 'var(--m3-on-surface)' }}>{step.label}</p>
              {step.detail && (
                <p className="text-xs mt-0.5 break-all" style={{ color: 'var(--m3-secondary)' }}>{step.detail}</p>
              )}
            </div>
            {step.durationMs != null && (
              <span className="text-xs font-mono shrink-0" style={{ color: 'var(--m3-secondary)' }}>
                {step.durationMs}ms
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

const TAG_PALETTE = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316',
  '#f59e0b', '#10b981', '#14b8a6', '#06b6d4', '#3b82f6',
]

function AddTagRow({ onAdd, existingTags = [] }: { onAdd: (t: MonitorTag) => void; existingTags?: MonitorTag[] }) {
  const [label, setLabel] = useState('')
  const [color, setColor] = useState(TAG_PALETTE[0]!)
  const [open, setOpen] = useState(false)

  const suggestions = label.trim()
    ? existingTags.filter((t) => t.label.toLowerCase().includes(label.toLowerCase()))
    : []

  function selectSuggestion(t: MonitorTag) {
    onAdd(t)
    setLabel('')
    setOpen(false)
  }

  function add() {
    if (!label.trim()) return
    onAdd({ label: label.trim(), color })
    setLabel('')
    setOpen(false)
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="relative" style={{ flex: '1 1 120px', minWidth: 0 }}>
        <input
          value={label}
          onChange={(e) => { setLabel(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder="Tag label…"
          className="input-sig text-sm w-full"
        />
        {open && suggestions.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 rounded-lg z-50 overflow-hidden"
            style={{ background: 'var(--m3-surface-container-high)', border: '1px solid var(--m3-outline-variant)', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
            {suggestions.map((t) => (
              <button key={t.label} type="button"
                onMouseDown={() => selectSuggestion(t)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left"
                style={{ color: 'var(--m3-on-surface)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--m3-surface-container)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
              >
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: t.color }} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex gap-1.5 flex-shrink-0">
        {TAG_PALETTE.map((c) => (
          <button key={c} type="button" onClick={() => setColor(c)}
            className="w-5 h-5 rounded-full transition-all"
            style={{
              background: c,
              transform: color === c ? 'scale(1.3)' : 'scale(1)',
              outline: color === c ? `2px solid ${c}` : 'none',
              outlineOffset: '2px',
            }}
          />
        ))}
      </div>
      <button type="button" onClick={add}
        className="text-xs px-3 py-1.5 rounded-lg font-semibold flex-shrink-0"
        style={{ background: 'var(--m3-primary-fixed)', color: 'var(--m3-primary)', border: '1px solid color-mix(in srgb, var(--m3-primary) 25%, transparent)' }}
      >Add</button>
    </div>
  )
}
