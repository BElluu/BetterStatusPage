import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api/client'
import type { Monitor, MonitorType, HttpsAuth, HttpsAuthType, VaultRef } from '@bsp/shared'

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
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  const [vaults, setVaults]                 = useState<VaultSummary[]>([])
  const [secretsByVault, setSecretsByVault] = useState<Record<number, SecretSummary[]>>({})

  useEffect(() => {
    api.get<VaultSummary[]>('/admin/vaults').then(setVaults).catch(() => {})
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
  }

  function updateConfig(key: string, value: unknown) {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const body = { name, type, intervalSecs, timeoutMs, config }
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

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.55)', overflowY: 'auto' }}>
      <div style={{ display: 'flex', minHeight: '100%', alignItems: 'flex-start', justifyContent: 'center', padding: '16px' }}>
      <div
        className="rounded-2xl w-full max-w-xl my-8"
        style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}
      >
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

          <Field label="Timeout (ms)">
            <input type="number" value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} min={1000} className="input-sig" />
          </Field>

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

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg transition-colors"
              style={{ color: 'var(--m3-secondary)' }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-on-surface)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-secondary)')}
            >
              Cancel
            </button>
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
      </div>
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
