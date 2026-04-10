import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api/client'
import type { Monitor, MonitorType, HttpsAuth, HttpsAuthType, VaultRef } from '@bsp/shared'

interface TestStep   { label: string; status: 'ok' | 'error' | 'info'; detail?: string; fullContent?: string; cookies?: Record<string, string>; durationMs?: number }
interface TestResult { overall: 'ok' | 'error'; steps: TestStep[]; totalMs: number }

interface Props {
  monitor: Monitor | null
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
}

const MONITOR_TYPES: { value: MonitorType; label: string }[] = [
  { value: 'https',     label: 'HTTPS' },
  { value: 'ping',      label: 'Ping / TCP' },
  { value: 'dns',       label: 'DNS' },
  { value: 'sqlserver', label: 'SQL Server' },
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

export default function MonitorFormModal({ monitor, onClose, onSaved }: Props) {
  const isEdit = !!monitor
  const [name, setName]               = useState(monitor?.name ?? '')
  const [type, setType]               = useState<MonitorType>(monitor?.type as MonitorType ?? 'https')
  const [intervalSecs, setIntervalSecs] = useState(monitor?.intervalSecs ?? 60)
  const [timeoutMs, setTimeoutMs]     = useState(monitor?.timeoutMs ?? 10000)
  const [config, setConfig]           = useState<Record<string, unknown>>(
    monitor ? (monitor.config as unknown as Record<string, unknown>) : (defaultConfigs.https as Record<string, unknown>),
  )
  const [retries, setRetries]         = useState(monitor?.retries ?? 1)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  const [vaults, setVaults]                 = useState<VaultSummary[]>([])
  const [secretsByVault, setSecretsByVault] = useState<Record<number, SecretSummary[]>>({})

  useEffect(() => {
    api.get<VaultSummary[]>('/admin/vaults').then(setVaults).catch(() => {})
  }, [])

  // Pre-load secrets for any vault already configured in the monitor being edited
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
    if (newType !== 'https') setShowAdvanced(false)
  }

  function updateConfig(key: string, value: unknown) {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }

  async function handleTest() {
    if (type !== 'https' && type !== 'sqlserver') return
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
    setError('')
    setLoading(true)
    try {
      const body = { name, type, intervalSecs, timeoutMs, retries, config }
      if (isEdit) {
        await api.patch(`/admin/monitors/${monitor.id}`, body)
      } else {
        await api.post('/admin/monitors', body)
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
          width: showAdvanced ? 'min(900px, calc(100vw - 32px))' : 'min(560px, calc(100vw - 32px))',
          background: 'var(--m3-surface-container-low)',
          border: '1px solid var(--m3-outline-variant)',
          transition: 'width 0.2s ease',
        }}
      >
      <div style={{ flex: '0 0 auto', width: showAdvanced ? '560px' : '100%', minWidth: 0 }}>
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
                  className="flex-1 text-xs font-medium py-1.5 rounded-md transition-all"
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

              {/* ── Headers & Body toggle ── */}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors"
                  style={{
                    color: showAdvanced ? 'var(--m3-primary)' : 'var(--m3-secondary)',
                    background: showAdvanced ? 'var(--m3-primary-fixed)' : 'var(--m3-surface-container)',
                    border: `1px solid ${showAdvanced ? 'color-mix(in srgb, var(--m3-primary) 25%, transparent)' : 'var(--m3-outline-variant)'}`,
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>tune</span>
                  Headers &amp; Body
                </button>
              </div>

              {/* ── Authorization ── */}
              <SectionDivider label="Authorization" />
              <div className="flex rounded-lg p-1 gap-1" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
                {AUTH_TYPES.map((at) => (
                  <button key={at.value} type="button" onClick={() => setAuthType(at.value)}
                    className="flex-1 text-xs font-medium py-1.5 rounded-md transition-all"
                    style={authType === at.value
                      ? { background: 'var(--m3-primary-fixed)', color: 'var(--m3-primary)', border: '1px solid color-mix(in srgb, var(--m3-primary) 25%, transparent)' }
                      : { color: 'var(--m3-secondary)', border: '1px solid transparent' }
                    }
                  >
                    {at.label}
                  </button>
                ))}
              </div>

              {authType === 'basic' && (
                <CredentialSection
                  {...vaultPickerProps}
                  vault={basicVault}
                  onVaultChange={(v) => updateBasic({ vault: v })}
                  mappingFields={JSON_MAPPING_FIELDS['basic']!}
                >
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Username">
                      <input value={(auth.basic as Record<string, unknown> | undefined)?.['username'] as string ?? ''} onChange={(e) => updateBasic({ username: e.target.value })} className="input-sig" autoComplete="off" />
                    </Field>
                    <Field label="Password">
                      <input type="password" value={(auth.basic as Record<string, unknown> | undefined)?.['password'] as string ?? ''} onChange={(e) => updateBasic({ password: e.target.value })} className="input-sig" autoComplete="new-password" />
                    </Field>
                  </div>
                </CredentialSection>
              )}

              {authType === 'oauth2' && (
                <>
                  {/* tokenUrl and scope are not secrets — always direct input */}
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Token URL">
                      <input value={(auth.oauth2 as Record<string, unknown> | undefined)?.['tokenUrl'] as string ?? ''} onChange={(e) => updateOAuth2({ tokenUrl: e.target.value })} className="input-sig" placeholder="https://auth.example.com/oauth/token" />
                    </Field>
                    <Field label="Scope (optional)">
                      <input value={(auth.oauth2 as Record<string, unknown> | undefined)?.['scope'] as string ?? ''} onChange={(e) => updateOAuth2({ scope: e.target.value })} className="input-sig" placeholder="read write" />
                    </Field>
                  </div>
                  {/* clientId / clientSecret can come from vault */}
                  <CredentialSection
                    {...vaultPickerProps}
                    vault={oauth2Vault}
                    onVaultChange={(v) => updateOAuth2({ vault: v })}
                    mappingFields={JSON_MAPPING_FIELDS['oauth2']!}
                  >
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Client ID">
                        <input value={(auth.oauth2 as Record<string, unknown> | undefined)?.['clientId'] as string ?? ''} onChange={(e) => updateOAuth2({ clientId: e.target.value })} className="input-sig" autoComplete="off" />
                      </Field>
                      <Field label="Client Secret">
                        <input type="password" value={(auth.oauth2 as Record<string, unknown> | undefined)?.['clientSecret'] as string ?? ''} onChange={(e) => updateOAuth2({ clientSecret: e.target.value })} className="input-sig" autoComplete="new-password" />
                      </Field>
                    </div>
                  </CredentialSection>
                </>
              )}

              {authType === 'cas' && (
                <>
                  {/* casServerUrl is not a secret — always direct input */}
                  <Field label="CAS Server URL">
                    <input value={(auth.cas as Record<string, unknown> | undefined)?.['casServerUrl'] as string ?? ''} onChange={(e) => updateCAS({ casServerUrl: e.target.value })} className="input-sig" placeholder="https://cas.example.com/cas" />
                  </Field>
                  {/* username / password can come from vault */}
                  <CredentialSection
                    {...vaultPickerProps}
                    vault={casVault}
                    onVaultChange={(v) => updateCAS({ vault: v })}
                    mappingFields={JSON_MAPPING_FIELDS['cas']!}
                  >
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Username">
                        <input value={(auth.cas as Record<string, unknown> | undefined)?.['username'] as string ?? ''} onChange={(e) => updateCAS({ username: e.target.value })} className="input-sig" autoComplete="off" />
                      </Field>
                      <Field label="Password">
                        <input type="password" value={(auth.cas as Record<string, unknown> | undefined)?.['password'] as string ?? ''} onChange={(e) => updateCAS({ password: e.target.value })} className="input-sig" autoComplete="new-password" />
                      </Field>
                    </div>
                  </CredentialSection>
                </>
              )}
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
                      className="px-4 py-1.5 text-xs font-medium transition-all"
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

          {/* ── Test result panel ─────────────────────────────────────────── */}
          {testResult && <TestResultPanel result={testResult} />}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg transition-colors"
              style={{ color: 'var(--m3-secondary)' }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-on-surface)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-secondary)')}
            >
              Cancel
            </button>
            {(type === 'https' || type === 'sqlserver') && (
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
              className="px-4 py-2 text-sm font-semibold rounded-lg transition-all"
              style={{
                background: loading ? 'var(--m3-surface-container-high)' : 'var(--m3-primary)',
                color:      loading ? 'var(--m3-secondary)' : 'var(--m3-on-primary)',
                opacity: loading ? 0.7 : 1,
              }}
            >
              {loading ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Monitor'}
            </button>
          </div>
        </form>
      </div>{/* inner scrollable column */}

      {/* ── Advanced side panel (headers / body) ─────────────────────────── */}
      {showAdvanced && (
        <div style={{
          flex: 1,
          minWidth: 0,
          borderLeft: '1px solid var(--m3-outline-variant)',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
            <span className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Headers &amp; Body</span>
            <button
              type="button"
              onClick={() => setShowAdvanced(false)}
              className="w-7 h-7 flex items-center justify-center rounded text-lg leading-none transition-colors"
              style={{ color: 'var(--m3-secondary)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-surface-container-high)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '' }}
            >×</button>
          </div>
          <div className="p-5 space-y-4 overflow-y-auto" style={{ flex: 1 }}>
            {/* Headers */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Request Headers</label>
                <button type="button" onClick={addHeader}
                  className="text-xs px-2 py-0.5 rounded transition-colors"
                  style={{ color: 'var(--m3-primary)', border: '1px solid color-mix(in srgb, var(--m3-primary) 30%, transparent)' }}
                >+ Add</button>
              </div>
              {headerRows.length === 0 && (
                <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No custom headers.</p>
              )}
              <div className="space-y-1.5">
                {headerRows.map(([k, v], idx) => (
                  <div key={idx} className="flex gap-1.5 items-center">
                    <input
                      className="input-sig text-xs flex-1"
                      placeholder="Header name"
                      value={k}
                      onChange={(e) => setHeader(idx, 'key', e.target.value)}
                    />
                    <input
                      className="input-sig text-xs flex-1"
                      placeholder="Value"
                      value={v}
                      onChange={(e) => setHeader(idx, 'value', e.target.value)}
                    />
                    <button type="button" onClick={() => removeHeader(idx)}
                      className="w-6 h-6 flex items-center justify-center rounded text-sm leading-none flex-shrink-0"
                      style={{ color: 'var(--m3-secondary)' }}
                    >×</button>
                  </div>
                ))}
              </div>
            </div>

            {/* Body */}
            <div>
              <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Request Body (JSON)</label>
              <textarea
                className="input-sig text-xs w-full font-mono"
                rows={10}
                placeholder={'{\n  "key": "value"\n}'}
                value={(config['body'] as string) ?? ''}
                onChange={(e) => updateConfig('body', e.target.value)}
                style={{ resize: 'vertical' }}
              />
            </div>
          </div>
        </div>
      )}

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
              className="px-4 py-1.5 text-xs font-medium transition-all"
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
    if (step.fullContent) {
      lines.push('    Full response body:')
      lines.push('    ' + step.fullContent.split('\n').join('\n    '))
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
