import { useState } from 'react'
import { CERT_REMINDER_DAYS, DEFAULT_CERT_WARN_DAYS, MAX_CERT_WARN_DAYS } from '@bsp/shared'
import type { CertExpiryConfig, MonitorType, VaultRef } from '@bsp/shared'
import { ConfirmModal } from '../ConfirmModal'
import { CopyButton } from '../CopyButton'
import { Alert } from '../ui'
import { ConnectionStringSection, CredentialSection } from './CredentialSection'
import { Field, JSON_MAPPING_FIELDS, Note, SectionDivider, type VaultPickerProps } from './monitorFormParts'

type Config = Record<string, unknown>

interface Props {
  type: MonitorType
  config: Config
  updateConfig: (key: string, value: unknown) => void
  vaultPicker: VaultPickerProps
  webhook: WebhookSectionProps
}

/** The check-specific settings of a monitor, switched on its type. */
export function MonitorTypeConfigFields({ type, config, updateConfig, vaultPicker, webhook }: Props) {
  switch (type) {
    case 'https':     return <HttpsFields config={config} updateConfig={updateConfig} />
    case 'ping':      return <PingFields config={config} updateConfig={updateConfig} />
    case 'dns':       return <DnsFields config={config} updateConfig={updateConfig} />
    case 'sqlserver': return <SqlServerFields config={config} updateConfig={updateConfig} vaultPicker={vaultPicker} />
    case 'docker':    return <DockerFields config={config} updateConfig={updateConfig} />
    case 'webhook':   return <WebhookSection {...webhook} />
    default:          return null
  }
}

interface ConfigProps {
  config: Config
  updateConfig: (key: string, value: unknown) => void
}

function HttpsFields({ config, updateConfig }: ConfigProps) {
  return (
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
      {/^https:\/\//i.test((config['url'] as string) ?? '') && <CertExpiryFields config={config} updateConfig={updateConfig} />}
    </>
  )
}

function CertExpiryFields({ config, updateConfig }: ConfigProps) {
  const certExpiry = config['certExpiry'] as CertExpiryConfig | undefined
  const enabled = certExpiry?.enabled ?? false
  const warnDays = certExpiry?.warnDays ?? DEFAULT_CERT_WARN_DAYS
  const reminders = CERT_REMINDER_DAYS.filter((days) => days < warnDays)
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none" style={{ color: 'var(--m3-on-surface-variant)' }}>
        <input type="checkbox" checked={enabled}
          onChange={(e) => updateConfig('certExpiry', { enabled: e.target.checked, warnDays })} />
        Warn before the TLS certificate expires
      </label>
      {enabled && (
        <>
          <Field label="Warn days before expiry">
            <input type="number" value={warnDays} min={1} max={MAX_CERT_WARN_DAYS} className="input-sig"
              onChange={(e) => updateConfig('certExpiry', { enabled, warnDays: Math.min(MAX_CERT_WARN_DAYS, Number(e.target.value)) })} />
          </Field>
          <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
            Sent to this monitor's channels{reminders.length > 0 ? `, with reminders ${reminders.join(', ')} ${reminders.length === 1 && reminders[0] === 1 ? 'day' : 'days'} before expiry` : ''}.
            The status page is not affected. An expired certificate already fails the check and alerts as down.
          </p>
        </>
      )}
    </div>
  )
}

function PingFields({ config, updateConfig }: ConfigProps) {
  return (
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
  )
}

function DockerFields({ config, updateConfig }: ConfigProps) {
  return (
    <>
      <Field label="Docker endpoint">
        <input value={(config['endpoint'] as string) ?? ''} onChange={(e) => updateConfig('endpoint', e.target.value)} required className="input-sig" placeholder="unix:///var/run/docker.sock" />
      </Field>
      <Note tone="info">Socket (unix://, npipe:////./pipe/docker_engine) or Docker API over HTTP(S), e.g. http://host:2375. Only read access is used.</Note>
      <Field label="Container name or ID">
        <input value={(config['container'] as string) ?? ''} onChange={(e) => updateConfig('container', e.target.value)} required className="input-sig" placeholder="my-app" />
      </Field>
    </>
  )
}

function DnsFields({ config, updateConfig }: ConfigProps) {
  return (
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
  )
}

function SqlServerFields({ config, updateConfig, vaultPicker }: ConfigProps & { vaultPicker: VaultPickerProps }) {
  const sqlMode = (config['mode'] as string) ?? 'fields'
  const sqlVault = config['vault'] as VaultRef | undefined
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
            {...vaultPicker}
            vault={sqlVault}
            onVaultChange={(v) => updateConfig('vault', v)}
            mappingFields={JSON_MAPPING_FIELDS.sqlserver}
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
          {...vaultPicker}
          vault={sqlVault}
          onVaultChange={(v) => updateConfig('vault', v)}
        />
      )}

      <Field label="Test Query">
        <input value={(config['query'] as string) ?? 'SELECT 1'} onChange={(e) => updateConfig('query', e.target.value)} className="input-sig" />
      </Field>
    </>
  )
}

export interface WebhookSectionProps {
  /** Present once the monitor has been saved; the URL is derived from it. */
  token: string | null
  /** Only a saved monitor can rotate its token. */
  canReset: boolean
  resetting: boolean
  /** Rotates the token; resolves once the new token is in place and rejects when it could not be rotated. */
  onReset: () => Promise<void>
}

export function webhookUrl(token: string) {
  return `${window.location.origin}/api/v1/hook/${token}`
}

function WebhookSection({ token, canReset, resetting, onReset }: WebhookSectionProps) {
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetError, setResetError] = useState('')

  async function handleConfirmReset() {
    setResetError('')
    try {
      await onReset()
    } catch (err) {
      setResetError(err instanceof Error && err.message ? err.message : 'Could not reset the token.')
    } finally {
      setConfirmReset(false)
    }
  }

  return (
    <div className="space-y-3">
      <Note tone="info">
        The monitor goes <strong>up</strong> when an external service sends a request to the webhook URL, and goes <strong>down</strong> if no request is received within the configured interval.
      </Note>

      {token ? (
        <>
          <Field label="Webhook URL">
            {(control) => (
              <div className="flex gap-2 items-stretch">
                <input
                  {...control}
                  readOnly
                  className="input-sig flex-1 font-mono text-xs"
                  value={webhookUrl(token)}
                />
                <CopyButton value={webhookUrl(token)} label="Copy" />
              </div>
            )}
          </Field>
          {resetError && <Alert tone="error">Couldn't reset the token: {resetError}</Alert>}
          {canReset && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setConfirmReset(true)}
                disabled={resetting}
                className="btn btn-outline btn-sm"
              >
                <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
                {resetting ? 'Resetting…' : 'Reset token'}
              </button>
            </div>
          )}
          {confirmReset && (
            <ConfirmModal
              title="Reset webhook token"
              message="The existing webhook URL will stop working. Any service that still calls it must be updated with the new URL."
              confirmLabel="Reset token"
              pending={resetting}
              pendingLabel="Resetting…"
              onConfirm={() => void handleConfirmReset()}
              onCancel={() => setConfirmReset(false)}
            />
          )}
        </>
      ) : (
        <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
          A unique webhook URL will be generated after saving.
        </p>
      )}
    </div>
  )
}
