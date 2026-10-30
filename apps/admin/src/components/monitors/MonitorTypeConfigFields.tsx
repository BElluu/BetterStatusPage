import { useState } from 'react'
import { CACHE_BUSTER_PARAM, CERT_REMINDER_DAYS, DEFAULT_CERT_WARN_DAYS, MAX_CERT_WARN_DAYS } from '@bsp/shared'
import type { CertExpiryConfig, DatabaseTlsMode, MonitorType } from '@bsp/shared'
import { ConfirmModal } from '@better-forge/ui'
import { CopyButton } from '@better-forge/ui'
import { Alert } from '@better-forge/ui'
import { Field, Note } from '@better-forge/ui'
import { DATABASE_ENGINES, DATABASE_DEFAULT_PORTS, DATABASE_DEFAULT_QUERIES } from './monitorTypes'
import { DomainFields, MailFields, RedisFields, SshFields, TlsCertFields } from './ServiceFields'

type Config = Record<string, unknown>

const DATABASE_TLS_OPTIONS: { value: DatabaseTlsMode; label: string }[] = [
  { value: 'verify', label: 'Encrypted, verify certificate' },
  { value: 'require', label: 'Encrypted, certificate not checked' },
  { value: 'prefer', label: 'Encrypted if available, certificate not checked' },
]

interface Props {
  type: MonitorType
  config: Config
  updateConfig: (key: string, value: unknown) => void
  onEngineChange: (engine: MonitorType) => void
  webhook: WebhookSectionProps
}

/** The check-specific settings of a monitor, switched on its type. */
export function MonitorTypeConfigFields({ type, config, updateConfig, onEngineChange, webhook }: Props) {
  switch (type) {
    case 'https':     return <HttpsFields config={config} updateConfig={updateConfig} />
    case 'ping':      return <PingFields config={config} updateConfig={updateConfig} />
    case 'dns':       return <DnsFields config={config} updateConfig={updateConfig} />
    case 'sqlserver':
    case 'postgresql':
    case 'mysql':
    case 'mongodb':
    case 'oracle':    return <DatabaseFields type={type} config={config} updateConfig={updateConfig} onEngineChange={onEngineChange} />
    case 'redis':     return <RedisFields config={config} updateConfig={updateConfig} />
    case 'mail':      return <MailFields config={config} updateConfig={updateConfig} />
    case 'ssh':       return <SshFields config={config} updateConfig={updateConfig} />
    case 'tls':       return <TlsCertFields config={config} updateConfig={updateConfig} />
    case 'domain':    return <DomainFields config={config} updateConfig={updateConfig} />
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
        <input value={(config['url'] as string) ?? ''} onChange={(e) => { updateConfig('url', e.target.value); if (!/^https:\/\//i.test(e.target.value)) updateConfig('ignoreTls', undefined) }} required className="input-sig" placeholder="https://example.com" />
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
      {config['method'] !== 'POST' && <CacheBusterField config={config} updateConfig={updateConfig} />}
      {/^https:\/\//i.test((config['url'] as string) ?? '') && <IgnoreTlsField config={config} updateConfig={updateConfig} />}
      {/^https:\/\//i.test((config['url'] as string) ?? '') && config['ignoreTls'] !== true && <CertExpiryFields config={config} updateConfig={updateConfig} />}
    </>
  )
}

function CacheBusterField({ config, updateConfig }: ConfigProps) {
  const on = config['cacheBuster'] === true
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none" style={{ color: 'var(--m3-on-surface-variant)' }}>
        <input type="checkbox" checked={on} onChange={(e) => updateConfig('cacheBuster', e.target.checked || undefined)} />
        Bypass caches
      </label>
      {on && (
        <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
          Adds a random <code>{CACHE_BUSTER_PARAM}</code> parameter to the first request, so a CDN or proxy cannot answer from its cache. Not used with CAS authentication.
        </p>
      )}
    </div>
  )
}

function IgnoreTlsField({ config, updateConfig }: ConfigProps) {
  const ignoreTls = config['ignoreTls'] === true
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none" style={{ color: 'var(--m3-on-surface-variant)' }}>
        <input type="checkbox" checked={ignoreTls} onChange={(e) => updateConfig('ignoreTls', e.target.checked || undefined)} />
        Ignore TLS certificate errors
      </label>
      {ignoreTls && (
        <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
          The server certificate is not verified, so a self-signed, expired or mismatched certificate is accepted. Use it only for
          endpoints you trust, such as devices on your LAN. Redirects the check follows are not verified either; requests to a separate
          authentication server still are. Certificate expiry warnings are off for this monitor.
        </p>
      )}
    </div>
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

function DatabaseFields({ type, config, updateConfig, onEngineChange }: ConfigProps & { type: MonitorType; onEngineChange: (engine: MonitorType) => void }) {
  const sqlMode = (config['mode'] as string) ?? 'fields'
  const tls = (config['tls'] as DatabaseTlsMode | undefined) ?? 'prefer'
  return (
    <>
      <div role="group" aria-labelledby="database-engine-label">
        <span id="database-engine-label" className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Engine</span>
        <div className="flex flex-wrap rounded-lg p-1 gap-1" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
          {DATABASE_ENGINES.map((e) => {
            const selected = e.value === type
            return (
              <button key={e.value} type="button" aria-pressed={selected} onClick={() => !selected && onEngineChange(e.value)}
                className={`flex-1 text-xs font-medium py-1.5 px-2 rounded-md transition-all whitespace-nowrap focus-ring ${selected ? 'selection-active' : ''}`}
                style={selected
                  ? { background: 'var(--m3-primary-fixed)', color: 'var(--m3-primary)', border: '1px solid color-mix(in srgb, var(--m3-primary) 25%, transparent)' }
                  : { color: 'var(--m3-secondary)', border: '1px solid transparent' }
                }
              >
                {e.label}
              </button>
            )
          })}
        </div>
      </div>

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
              <input type="number" value={(config['port'] as number) ?? DATABASE_DEFAULT_PORTS[type]} onChange={(e) => updateConfig('port', Number(e.target.value))} className="input-sig" />
            </Field>
          </div>
          <Field label={type === 'oracle' ? 'Service name' : 'Database'}>
            <input value={(config['database'] as string) ?? ''} onChange={(e) => updateConfig('database', e.target.value)} required className="input-sig" />
          </Field>
          <Field label="Connection security">
            <select value={tls} onChange={(e) => updateConfig('tls', e.target.value)} className="input-sig">
              {DATABASE_TLS_OPTIONS.filter((o) => type !== 'oracle' || o.value !== 'require').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          {tls === 'prefer' && (
            <Note tone="warning">
              The certificate is not checked{type === 'mongodb' ? ' and MongoDB is not encrypted at all' : type === 'oracle' ? ' and Oracle is not encrypted at all' : type === 'sqlserver' ? '' : ', and the connection falls back to plain text when the server has no TLS'}.
              Anyone on the network path can {type === 'sqlserver' ? 'impersonate the server and read the password' : 'read the password'}. Choose <strong>Encrypted, verify certificate</strong>.
            </Note>
          )}
          {tls === 'require' && (
            <Note tone="warning">The certificate is not checked, so a party on the network path can still impersonate the server. Choose <strong>Encrypted, verify certificate</strong> if you can.</Note>
          )}
          {tls === 'verify' && (
            <Field label="CA certificate (optional)">
              <textarea value={(config['tlsCa'] as string) ?? ''} onChange={(e) => updateConfig('tlsCa', e.target.value)} className="input-sig text-xs font-mono" rows={4} style={{ resize: 'vertical' }}
                placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----\n\nEmpty = the CAs trusted by the server running BetterStatusPage'} />
            </Field>
          )}
        </>
      )}

      {sqlMode === 'connectionString' && (
        <Note tone="info">
          The connection string lives in Vault. Choose it under <strong>Credentials</strong>.
          {type === 'oracle' && <> For Oracle it reads <code>user/password@host:port/service_name</code>, or a full connect descriptor after the <code>@</code>.</>}
        </Note>
      )}

      <Field label={type === 'mongodb' ? 'Test Command (JSON)' : 'Test Query'}>
        <input value={(config['query'] as string) ?? DATABASE_DEFAULT_QUERIES[type]} onChange={(e) => updateConfig('query', e.target.value)} className="input-sig" />
      </Field>
      <Field label="Expected Result (optional)">
        <input value={(config['expectedResult'] as string) ?? ''} onChange={(e) => updateConfig('expectedResult', e.target.value)} className="input-sig" placeholder="First column of the first row; empty = any" />
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
        The monitor goes <strong>up</strong> when an external service sends a request to the webhook URL, and goes <strong>down</strong> if no request is received within the configured interval. A job that failed can say so at once: add <code>?status=down&amp;msg=reason</code> (or <code>status=degraded</code>) to the URL.
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
