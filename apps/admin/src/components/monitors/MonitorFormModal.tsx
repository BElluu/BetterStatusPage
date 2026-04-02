import { useState } from 'react'
import { api } from '../../api/client'
import type { Monitor, MonitorGroup, MonitorType } from '@bsp/shared'

interface Props {
  monitor: Monitor | null
  groups: MonitorGroup[]
  onClose: () => void
  onSaved: () => void
}

const defaultConfigs: Record<MonitorType, Record<string, unknown>> = {
  https: { url: 'https://', method: 'GET', expectedStatus: 200 },
  ping: { host: '', mode: 'tcp', port: 80 },
  dns: { hostname: '', recordType: 'A' },
  sqlserver: { host: '', port: 1433, database: '', user: '', password: '', query: 'SELECT 1' },
}

export default function MonitorFormModal({ monitor, groups, onClose, onSaved }: Props) {
  const isEdit = !!monitor
  const [name, setName] = useState(monitor?.name ?? '')
  const [type, setType] = useState<MonitorType>(monitor?.type as MonitorType ?? 'https')
  const [groupId, setGroupId] = useState<number | ''>(monitor?.groupId ?? '')
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
      const body = {
        name,
        type,
        groupId: groupId === '' ? undefined : groupId,
        intervalSecs,
        timeoutMs,
        config,
      }
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-slate-800">
          <h3 className="text-lg font-semibold text-white">{isEdit ? 'Edit Monitor' : 'New Monitor'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg px-4 py-3 text-sm">
              {error}
            </div>
          )}

          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className={inputCls}
              placeholder="My Service"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Type">
              <select value={type} onChange={(e) => handleTypeChange(e.target.value as MonitorType)} className={inputCls}>
                <option value="https">HTTPS</option>
                <option value="ping">Ping / TCP</option>
                <option value="dns">DNS</option>
                <option value="sqlserver">SQL Server</option>
              </select>
            </Field>

            <Field label="Group">
              <select value={groupId} onChange={(e) => setGroupId(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
                <option value="">None</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Interval (seconds)">
              <input type="number" value={intervalSecs} onChange={(e) => setIntervalSecs(Number(e.target.value))} min={10} className={inputCls} />
            </Field>
            <Field label="Timeout (ms)">
              <input type="number" value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} min={1000} className={inputCls} />
            </Field>
          </div>

          {/* Type-specific fields */}
          {type === 'https' && (
            <>
              <Field label="URL">
                <input value={(config['url'] as string) ?? ''} onChange={(e) => updateConfig('url', e.target.value)} required className={inputCls} placeholder="https://example.com" />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Method">
                  <select value={(config['method'] as string) ?? 'GET'} onChange={(e) => updateConfig('method', e.target.value)} className={inputCls}>
                    <option>GET</option>
                    <option>POST</option>
                    <option>HEAD</option>
                  </select>
                </Field>
                <Field label="Expected Status">
                  <input type="number" value={(config['expectedStatus'] as number) ?? 200} onChange={(e) => updateConfig('expectedStatus', Number(e.target.value))} className={inputCls} />
                </Field>
              </div>
              <Field label="Keyword (optional)">
                <input value={(config['keyword'] as string) ?? ''} onChange={(e) => updateConfig('keyword', e.target.value)} className={inputCls} placeholder="must contain…" />
              </Field>
            </>
          )}

          {type === 'ping' && (
            <>
              <Field label="Host">
                <input value={(config['host'] as string) ?? ''} onChange={(e) => updateConfig('host', e.target.value)} required className={inputCls} placeholder="192.168.1.1" />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Mode">
                  <select value={(config['mode'] as string) ?? 'tcp'} onChange={(e) => updateConfig('mode', e.target.value)} className={inputCls}>
                    <option value="tcp">TCP</option>
                    <option value="icmp">ICMP</option>
                  </select>
                </Field>
                <Field label="Port">
                  <input type="number" value={(config['port'] as number) ?? 80} onChange={(e) => updateConfig('port', Number(e.target.value))} className={inputCls} />
                </Field>
              </div>
            </>
          )}

          {type === 'dns' && (
            <>
              <Field label="Hostname">
                <input value={(config['hostname'] as string) ?? ''} onChange={(e) => updateConfig('hostname', e.target.value)} required className={inputCls} placeholder="example.com" />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Record Type">
                  <select value={(config['recordType'] as string) ?? 'A'} onChange={(e) => updateConfig('recordType', e.target.value)} className={inputCls}>
                    <option>A</option>
                    <option>AAAA</option>
                    <option>MX</option>
                    <option>CNAME</option>
                    <option>TXT</option>
                  </select>
                </Field>
                <Field label="Expected Value (optional)">
                  <input value={(config['expectedValue'] as string) ?? ''} onChange={(e) => updateConfig('expectedValue', e.target.value)} className={inputCls} placeholder="1.2.3.4" />
                </Field>
              </div>
              <Field label="Custom Resolver (optional)">
                <input value={(config['resolver'] as string) ?? ''} onChange={(e) => updateConfig('resolver', e.target.value)} className={inputCls} placeholder="8.8.8.8" />
              </Field>
            </>
          )}

          {type === 'sqlserver' && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Host">
                  <input value={(config['host'] as string) ?? ''} onChange={(e) => updateConfig('host', e.target.value)} required className={inputCls} placeholder="localhost" />
                </Field>
                <Field label="Port">
                  <input type="number" value={(config['port'] as number) ?? 1433} onChange={(e) => updateConfig('port', Number(e.target.value))} className={inputCls} />
                </Field>
              </div>
              <Field label="Database">
                <input value={(config['database'] as string) ?? ''} onChange={(e) => updateConfig('database', e.target.value)} required className={inputCls} />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="User">
                  <input value={(config['user'] as string) ?? ''} onChange={(e) => updateConfig('user', e.target.value)} required className={inputCls} />
                </Field>
                <Field label="Password">
                  <input type="password" value={(config['password'] as string) ?? ''} onChange={(e) => updateConfig('password', e.target.value)} required className={inputCls} />
                </Field>
              </div>
              <Field label="Test Query">
                <input value={(config['query'] as string) ?? 'SELECT 1'} onChange={(e) => updateConfig('query', e.target.value)} className={inputCls} />
              </Field>
            </>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium rounded-lg transition-colors"
            >
              {loading ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Monitor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

const inputCls = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-slate-400 mb-1.5">{label}</label>
      {children}
    </div>
  )
}
