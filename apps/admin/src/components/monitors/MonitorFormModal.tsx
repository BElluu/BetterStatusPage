import { useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api/client'
import type { Monitor, MonitorType } from '@bsp/shared'

interface Props {
  monitor: Monitor | null
  onClose: () => void
  onSaved: () => void
}

const defaultConfigs: Record<MonitorType, Record<string, unknown>> = {
  https:     { url: 'https://', method: 'GET', expectedStatus: 200 },
  ping:      { host: '', mode: 'tcp', port: 80 },
  dns:       { hostname: '', recordType: 'A' },
  sqlserver: { host: '', port: 1433, database: '', user: '', password: '', query: 'SELECT 1' },
}

const types: { value: MonitorType; label: string }[] = [
  { value: 'https',     label: 'HTTPS' },
  { value: 'ping',      label: 'Ping / TCP' },
  { value: 'dns',       label: 'DNS' },
  { value: 'sqlserver', label: 'SQL Server' },
]

export default function MonitorFormModal({ monitor, onClose, onSaved }: Props) {
  const isEdit = !!monitor
  const [name, setName] = useState(monitor?.name ?? '')
  const [type, setType] = useState<MonitorType>(monitor?.type as MonitorType ?? 'https')
  const [intervalSecs, setIntervalSecs] = useState(monitor?.intervalSecs ?? 60)
  const [timeoutMs, setTimeoutMs] = useState(monitor?.timeoutMs ?? 10000)
  const [config, setConfig] = useState<Record<string, unknown>>(
    monitor ? (monitor.config as unknown as Record<string, unknown>) : (defaultConfigs.https as Record<string, unknown>),
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.55)', overflowY: 'auto' }}>
      <div style={{ display: 'flex', minHeight: '100%', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div
        className="rounded-2xl w-full max-w-lg"
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
            <div
              className="rounded-lg px-4 py-3 text-sm"
              style={{ background: 'rgba(255,77,106,0.08)', border: '1px solid rgba(255,77,106,0.2)', color: 'var(--m3-down)' }}
            >
              {error}
            </div>
          )}

          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="input-sig"
              placeholder="My Service"
            />
          </Field>

          {/* Type tab selector */}
          <div>
            <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
              Type
            </label>
            <div
              className="flex rounded-lg p-1 gap-1"
              style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}
            >
              {types.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => handleTypeChange(t.value)}
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

          {/* Divider */}
          <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

          {/* Type-specific fields */}
          {type === 'https' && (
            <>
              <Field label="URL">
                <input value={(config['url'] as string) ?? ''} onChange={(e) => updateConfig('url', e.target.value)} required className="input-sig" placeholder="https://example.com" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Method">
                  <select value={(config['method'] as string) ?? 'GET'} onChange={(e) => updateConfig('method', e.target.value)} className="input-sig">
                    <option>GET</option>
                    <option>POST</option>
                    <option>HEAD</option>
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

          {type === 'dns' && (
            <>
              <Field label="Hostname">
                <input value={(config['hostname'] as string) ?? ''} onChange={(e) => updateConfig('hostname', e.target.value)} required className="input-sig" placeholder="example.com" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Record Type">
                  <select value={(config['recordType'] as string) ?? 'A'} onChange={(e) => updateConfig('recordType', e.target.value)} className="input-sig">
                    <option>A</option>
                    <option>AAAA</option>
                    <option>MX</option>
                    <option>CNAME</option>
                    <option>TXT</option>
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

          {type === 'sqlserver' && (
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
              <div className="grid grid-cols-2 gap-3">
                <Field label="User">
                  <input value={(config['user'] as string) ?? ''} onChange={(e) => updateConfig('user', e.target.value)} required className="input-sig" />
                </Field>
                <Field label="Password">
                  <input type="password" value={(config['password'] as string) ?? ''} onChange={(e) => updateConfig('password', e.target.value)} required className="input-sig" />
                </Field>
              </div>
              <Field label="Test Query">
                <input value={(config['query'] as string) ?? 'SELECT 1'} onChange={(e) => updateConfig('query', e.target.value)} className="input-sig" />
              </Field>
            </>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg transition-colors"
              style={{ color: 'var(--m3-secondary)' }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-on-surface)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-secondary)')}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 text-sm font-semibold rounded-lg transition-all"
              style={{
                background: loading ? 'var(--m3-surface-container-high)' : 'var(--m3-primary)',
                color: loading ? 'var(--m3-secondary)' : 'var(--m3-on-primary)',
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
