import { useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api/client'
import type { NotificationChannel } from '@bsp/shared'

interface Props {
  channel: NotificationChannel | null
  onClose: () => void
  onSaved: () => void
}

const VARS = ['{{monitor_name}}', '{{monitor_type}}', '{{status}}', '{{previous_status}}', '{{error_message}}', '{{checked_at}}']

const DEFAULT_EMAIL_SUBJECT = 'Monitor {{monitor_name}} is {{status}}'
const DEFAULT_EMAIL_BODY = `Monitor: {{monitor_name}}
Type:    {{monitor_type}}
Status:  {{status}}
Error:   {{error_message}}
Time:    {{checked_at}}`

const DEFAULT_WEBHOOK_BODY = `{
  "monitor": "{{monitor_name}}",
  "status": "{{status}}",
  "error": "{{error_message}}",
  "time": "{{checked_at}}"
}`

export default function ChannelFormModal({ channel, onClose, onSaved }: Props) {
  const isEdit = !!channel
  const [name, setName]   = useState(channel?.name ?? '')
  const [type, setType]   = useState<'email' | 'webhook'>(channel?.type as 'email' | 'webhook' ?? 'email')
  const [enabled, setEnabled]               = useState((channel?.enabled ?? 1) === 1)
  const [notifyOnRecovery, setNotifyOnRecovery] = useState((channel?.notifyOnRecovery ?? 0) === 1)

  // Email config
  const emailCfg = channel?.type === 'email' ? (channel.config as { to: string; subject: string; body: string }) : null
  const [emailTo, setEmailTo]         = useState(emailCfg?.to ?? '')
  const [emailSubject, setEmailSubject] = useState(emailCfg?.subject ?? DEFAULT_EMAIL_SUBJECT)
  const [emailBody, setEmailBody]     = useState(emailCfg?.body ?? DEFAULT_EMAIL_BODY)

  // Webhook config
  const whCfg = channel?.type === 'webhook' ? (channel.config as { url: string; method: string; headers?: Record<string, string>; body?: string }) : null
  const [whUrl, setWhUrl]         = useState(whCfg?.url ?? '')
  const [whMethod, setWhMethod]   = useState(whCfg?.method ?? 'POST')
  const [whHeaders, setWhHeaders] = useState<[string, string][]>(Object.entries(whCfg?.headers ?? {}))
  const [whBody, setWhBody]       = useState(whCfg?.body ?? DEFAULT_WEBHOOK_BODY)

  const [loading, setLoading]   = useState(false)
  const [testing, setTesting]   = useState(false)
  const [testMsg, setTestMsg]   = useState<{ ok: boolean; text: string } | null>(null)
  const [error, setError]       = useState('')

  function buildConfig() {
    if (type === 'email') {
      return { to: emailTo, subject: emailSubject, body: emailBody }
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of whHeaders) { if (k) headers[k] = v }
    const hasBody = whMethod !== 'GET' && whMethod !== 'HEAD'
    return { url: whUrl, method: whMethod, headers: Object.keys(headers).length ? headers : undefined, body: hasBody && whBody ? whBody : undefined }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const body = { name, type, config: buildConfig(), enabled: enabled ? 1 : 0, notifyOnRecovery: notifyOnRecovery ? 1 : 0 }
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

  function addHeader() { setWhHeaders((h) => [...h, ['', '']]) }
  function removeHeader(i: number) { setWhHeaders((h) => h.filter((_, idx) => idx !== i)) }
  function updateHeader(i: number, field: 0 | 1, val: string) {
    setWhHeaders((h) => h.map((row, idx) => idx === i ? (field === 0 ? [val, row[1]] : [row[0], val]) : row))
  }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.55)', overflowY: 'auto' }}>
      <div style={{ display: 'flex', minHeight: '100%', alignItems: 'flex-start', justifyContent: 'center', padding: '16px' }}>
        <div className="rounded-2xl w-full max-w-xl my-8"
          style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-5" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
            <h3 className="font-headline font-bold text-lg" style={{ color: 'var(--m3-on-surface)' }}>
              {isEdit ? 'Edit Channel' : 'New Notification Channel'}
            </h3>
            <button onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-xl leading-none transition-colors"
              style={{ color: 'var(--m3-secondary)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-surface-container-high)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '' }}
            >×</button>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {error && (
              <div className="rounded-lg px-4 py-3 text-sm" style={{ background: 'rgba(255,77,106,0.08)', border: '1px solid rgba(255,77,106,0.2)', color: 'var(--m3-down)' }}>
                {error}
              </div>
            )}

            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} required className="input-sig" placeholder="My Email Alert" />
            </Field>

            {/* Type toggle */}
            <div>
              <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Type</label>
              <div className="flex rounded-lg p-1 gap-1" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
                {(['email', 'webhook'] as const).map((t) => (
                  <button key={t} type="button" onClick={() => setType(t)}
                    className="flex-1 text-xs font-medium py-1.5 rounded-md transition-all flex items-center justify-center gap-1.5"
                    style={type === t
                      ? { background: 'var(--m3-primary-fixed)', color: 'var(--m3-primary)', border: '1px solid color-mix(in srgb, var(--m3-primary) 25%, transparent)' }
                      : { color: 'var(--m3-secondary)', border: '1px solid transparent' }
                    }
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>{t === 'email' ? 'mail' : 'webhook'}</span>
                    {t === 'email' ? 'Email' : 'Webhook'}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

            {/* ── Email config ── */}
            {type === 'email' && (
              <>
                <Field label="To">
                  <input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} required className="input-sig" placeholder="ops@example.com" />
                </Field>
                <Field label="Subject">
                  <input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} required className="input-sig" />
                </Field>
                <Field label="Body">
                  <textarea value={emailBody} onChange={(e) => setEmailBody(e.target.value)} rows={6} className="input-sig w-full font-mono text-xs" style={{ resize: 'vertical' }} />
                </Field>
                <VarsHint />
              </>
            )}

            {/* ── Webhook config ── */}
            {type === 'webhook' && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <Field label="URL">
                      <input value={whUrl} onChange={(e) => setWhUrl(e.target.value)} required className="input-sig" placeholder="https://example.com/alert" />
                    </Field>
                  </div>
                  <Field label="Method">
                    <select value={whMethod} onChange={(e) => setWhMethod(e.target.value)} className="input-sig">
                      <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option>
                    </select>
                  </Field>
                </div>

                {/* Headers */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Headers</label>
                    <button type="button" onClick={addHeader}
                      className="text-xs px-2 py-0.5 rounded"
                      style={{ color: 'var(--m3-primary)', border: '1px solid color-mix(in srgb, var(--m3-primary) 30%, transparent)' }}
                    >+ Add</button>
                  </div>
                  <div className="space-y-1.5">
                    {whHeaders.map(([k, v], i) => (
                      <div key={i} className="flex gap-1.5 items-center">
                        <input className="input-sig text-xs flex-1" placeholder="Header" value={k} onChange={(e) => updateHeader(i, 0, e.target.value)} />
                        <input className="input-sig text-xs flex-1" placeholder="Value" value={v} onChange={(e) => updateHeader(i, 1, e.target.value)} />
                        <button type="button" onClick={() => removeHeader(i)}
                          className="w-6 h-6 flex items-center justify-center rounded text-sm flex-shrink-0"
                          style={{ color: 'var(--m3-secondary)' }}
                        >×</button>
                      </div>
                    ))}
                    {whHeaders.length === 0 && <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No custom headers.</p>}
                  </div>
                </div>

                {whMethod !== 'GET' && whMethod !== 'HEAD' && (
                  <Field label="Body">
                    <textarea value={whBody} onChange={(e) => setWhBody(e.target.value)} rows={6} className="input-sig w-full font-mono text-xs" style={{ resize: 'vertical' }} />
                  </Field>
                )}
                <VarsHint />
              </>
            )}

            <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

            {/* Toggles */}
            <div className="space-y-3">
              <Toggle label="Enabled" checked={enabled} onChange={setEnabled} />
              <Toggle label="Notify on recovery (when monitor comes back up)" checked={notifyOnRecovery} onChange={setNotifyOnRecovery} />
            </div>

            {/* Test result */}
            {testMsg && (
              <div className="rounded-lg px-4 py-3 text-xs"
                style={{
                  background: testMsg.ok ? 'rgba(34,197,94,0.08)' : 'rgba(255,77,106,0.08)',
                  border: `1px solid ${testMsg.ok ? 'rgba(34,197,94,0.25)' : 'rgba(255,77,106,0.2)'}`,
                  color: testMsg.ok ? '#22c55e' : 'var(--m3-down)',
                }}
              >
                {testMsg.text}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-1">
              <button type="button" onClick={onClose}
                className="px-4 py-2 text-sm rounded-lg"
                style={{ color: 'var(--m3-secondary)' }}
              >Cancel</button>
              {isEdit && (
                <button type="button" onClick={handleTest} disabled={testing}
                  className="px-4 py-2 text-sm font-semibold rounded-lg transition-all flex items-center gap-1.5"
                  style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface)', border: '1px solid var(--m3-outline-variant)', opacity: testing ? 0.7 : 1 }}
                >
                  {testing ? <><span className="material-symbols-outlined animate-spin" style={{ fontSize: '15px' }}>progress_activity</span> Testing…</> : 'Send Test'}
                </button>
              )}
              <button type="submit" disabled={loading}
                className="px-4 py-2 text-sm font-semibold rounded-lg transition-all"
                style={{ background: loading ? 'var(--m3-surface-container-high)' : 'var(--m3-primary)', color: loading ? 'var(--m3-secondary)' : 'var(--m3-on-primary)', opacity: loading ? 0.7 : 1 }}
              >
                {loading ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Channel'}
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
      <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>{label}</label>
      {children}
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer select-none">
      <div
        className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
        style={{ background: checked ? 'var(--m3-primary)' : 'var(--m3-outline-variant)' }}
        onClick={() => onChange(!checked)}
      >
        <div
          className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
          style={{ background: checked ? 'var(--m3-on-primary)' : 'var(--m3-secondary)', left: checked ? '22px' : '2px' }}
        />
      </div>
      <span className="text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>{label}</span>
    </label>
  )
}

function VarsHint() {
  return (
    <div className="rounded-lg px-3 py-2.5 space-y-1.5" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
      <p className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Available variables</p>
      <div className="flex flex-wrap gap-1.5">
        {VARS.map((v) => (
          <code key={v} className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-primary)', fontFamily: 'monospace' }}>{v}</code>
        ))}
      </div>
    </div>
  )
}
