import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { Alert, ErrorState, Field, LoadingState, Switch, useToast } from './ui'
import { ModalShell } from './ModalShell'

interface OidcSettings {
  enabled: boolean
  issuer: string
  clientId: string
  hasClientSecret: boolean
  scopes: string
  redirectUri: string
  buttonLabel: string
  allowUnverifiedEmail: boolean
  disablePasswordLogin: boolean
}
interface OidcResponse { source: 'env' | 'database' | 'none'; envManaged: boolean; defaultRedirectUri: string; settings: OidcSettings }
interface Message { tone: 'success' | 'error'; text: string }

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
const CARD = { background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)', color: 'var(--m3-on-surface)' }

export function SingleSignOnModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<OidcResponse | null>(null)
  const [form, setForm] = useState<OidcSettings | null>(null)
  const [clientSecret, setClientSecret] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const toast = useToast()

  const load = useCallback(() => api.get<OidcResponse>('/admin/oidc')
    .then((res) => { setData(res); setForm(res.settings); setLoadError('') })
    .catch((e: unknown) => setLoadError(errorText(e))), [])
  useEffect(() => { void load() }, [load])

  if (!data || !form) {
    return <ModalShell align="top" onClose={onClose} label="Single sign-on">
      <div className="rounded-2xl p-6 w-full max-w-2xl" style={CARD}>
        {loadError ? <ErrorState message={loadError} onRetry={() => void load()} /> : <LoadingState label="Loading sign-in settings…" />}
        {loadError && <button type="button" className="btn btn-secondary mt-4" onClick={onClose}>Close</button>}
      </div>
    </ModalShell>
  }

  const locked = data.envManaged
  const update = (changes: Partial<OidcSettings>) => setForm({ ...form, ...changes })
  const redirectUri = form.redirectUri || data.defaultRedirectUri

  async function test() {
    setBusy('test'); setMessage(null)
    try {
      const result = await api.post<{ issuer: string }>('/admin/oidc/test', { issuer: form!.issuer, clientId: form!.clientId, redirectUri: form!.redirectUri })
      setMessage({ tone: 'success', text: `Connected to ${result.issuer}.` })
    } catch (e) { setMessage({ tone: 'error', text: errorText(e) }) } finally { setBusy(null) }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy('save'); setMessage(null)
    try {
      const saved = await api.put<OidcSettings>('/admin/oidc', {
        ...form, clientSecret, clearClientSecret: clearSecret, currentPassword,
      })
      toast.success(saved.enabled ? 'Single sign-on settings saved. They apply immediately.' : 'Single sign-on settings saved.')
      onClose()
    } catch (err) { setMessage({ tone: 'error', text: errorText(err) }); setBusy(null) }
  }

  return <ModalShell align="top" onClose={busy ? undefined : onClose} label="Single sign-on">
    <div className="w-full max-w-2xl space-y-3">
    {locked && <Alert tone="warning">Single sign-on is configured through OIDC_* environment variables on the server. Remove them to manage it here.</Alert>}
    {message && <Alert tone={message.tone} onDismiss={() => setMessage(null)}>{message.text}</Alert>}
    <form onSubmit={save} className="rounded-2xl p-6 space-y-5 w-full" style={CARD}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-headline text-xl font-semibold">OpenID Connect</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>
            Users must already exist; they are matched by the verified email from the identity provider.
          </p>
        </div>
        <Switch checked={form.enabled} disabled={locked} onChange={(enabled) => update({ enabled })} aria-label="Enable single sign-on" />
      </div>

      <fieldset disabled={locked || busy !== null} className="space-y-4">
        <Field label="Issuer URL" hint="For example https://login.microsoftonline.com/<tenant>/v2.0 or https://keycloak.example.com/realms/main">
          <input className="input-m3" value={form.issuer} onChange={(e) => update({ issuer: e.target.value })} placeholder="https://idp.example.com" />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Client ID">
            <input className="input-m3" value={form.clientId} onChange={(e) => update({ clientId: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Client secret" hint={form.hasClientSecret && !clearSecret ? 'A secret is stored. Leave empty to keep it.' : 'Optional for public clients.'}>
            <input
              className="input-m3" type="password" autoComplete="new-password" value={clientSecret}
              onChange={(e) => { setClientSecret(e.target.value); setClearSecret(false) }}
              placeholder={form.hasClientSecret && !clearSecret ? '••••••••' : ''}
            />
          </Field>
        </div>
        {form.hasClientSecret && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={clearSecret} onChange={(e) => { setClearSecret(e.target.checked); if (e.target.checked) setClientSecret('') }} />
            Remove the stored client secret
          </label>
        )}
        <Field label="Redirect URI" hint={redirectUri ? <>Register <code>{redirectUri}</code> as the callback URL in your identity provider.</> : 'Set PUBLIC_URL on the server or enter the callback URL here.'}>
          <input className="input-m3" value={form.redirectUri} onChange={(e) => update({ redirectUri: e.target.value })} placeholder={data.defaultRedirectUri} />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Scopes">
            <input className="input-m3" value={form.scopes} onChange={(e) => update({ scopes: e.target.value })} placeholder="openid email profile" />
          </Field>
          <Field label="Button label">
            <input className="input-m3" value={form.buttonLabel} onChange={(e) => update({ buttonLabel: e.target.value })} placeholder="Sign in with SSO" />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={form.allowUnverifiedEmail} onChange={(e) => update({ allowUnverifiedEmail: e.target.checked })} />
          <span>Accept identity providers that omit <code>email_verified</code>. Enable only if the email claim is trustworthy. Not needed for Microsoft Entra ID: add the <code>xms_edov</code> optional claim instead.</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={form.disablePasswordLogin} onChange={(e) => update({ disablePasswordLogin: e.target.checked })} />
          <span>Disable password sign-in. The identity provider must be reachable to save this. Set <code>OIDC_FORCE_PASSWORD_LOGIN=true</code> on the server to recover if it goes down.</span>
        </label>
      </fieldset>

      {!locked && <>
        <Field label="Your current password" hint="Required to change sign-in settings.">
          <input className="input-m3" type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy !== null} className="btn btn-primary">{busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button type="button" disabled={busy !== null || !form.issuer || !form.clientId} onClick={() => void test()} className="btn btn-secondary">
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          <button type="button" disabled={busy !== null} onClick={onClose} className="btn btn-secondary ml-auto">Close</button>
        </div>
      </>}
      {locked && <button type="button" onClick={onClose} className="btn btn-secondary">Close</button>}
    </form>
    </div>
  </ModalShell>
}
