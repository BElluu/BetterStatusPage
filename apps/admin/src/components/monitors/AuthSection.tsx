import type { HttpsAuth, HttpsAuthType, VaultRef } from '@bsp/shared'
import { CredentialSection } from './CredentialSection'
import { Field, JSON_MAPPING_FIELDS, type VaultPickerProps } from './monitorFormParts'

const AUTH_TYPES: { value: HttpsAuthType; label: string }[] = [
  { value: 'none',   label: 'None' },
  { value: 'basic',  label: 'Basic' },
  { value: 'oauth2', label: 'OAuth2' },
  { value: 'cas',    label: 'CAS' },
]

type Section = Record<string, unknown> | undefined

/** Reads the HTTPS auth block of a monitor config, defaulting to no auth. */
export function readAuth(config: Record<string, unknown>): HttpsAuth {
  return (config['auth'] as HttpsAuth | undefined) ?? { type: 'none' as HttpsAuthType }
}

/** HTTPS authentication settings: the scheme switcher plus the credentials each scheme needs. */
export function AuthSection({ auth, onChange, vaultPicker }: { auth: HttpsAuth; onChange: (auth: HttpsAuth) => void; vaultPicker: VaultPickerProps }) {
  const authType = auth.type ?? 'none'
  const basic  = auth.basic  as Section
  const oauth2 = auth.oauth2 as Section
  const cas    = auth.cas    as Section

  function setAuthType(t: HttpsAuthType) { onChange({ ...auth, type: t }) }
  function updateBasic(patch: Record<string, unknown>)  { onChange({ ...auth, basic:  { ...(auth.basic  ?? {}), ...patch } } as HttpsAuth) }
  function updateOAuth2(patch: Record<string, unknown>) { onChange({ ...auth, oauth2: { ...(auth.oauth2 ?? {}), ...patch } } as HttpsAuth) }
  function updateCAS(patch: Record<string, unknown>)    { onChange({ ...auth, cas:    { ...(auth.cas    ?? {}), ...patch } } as HttpsAuth) }

  const text = (section: Section, key: string) => (section?.[key] as string | undefined) ?? ''

  return (
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
        <CredentialSection {...vaultPicker} vault={basic?.['vault'] as VaultRef | undefined} onVaultChange={(v) => updateBasic({ vault: v })} mappingFields={JSON_MAPPING_FIELDS.basic}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username"><input value={text(basic, 'username')} onChange={(e) => updateBasic({ username: e.target.value })} className="input-sig" autoComplete="off" /></Field>
            <Field label="Password"><input type="password" value={text(basic, 'password')} onChange={(e) => updateBasic({ password: e.target.value })} className="input-sig" autoComplete="new-password" /></Field>
          </div>
        </CredentialSection>
      )}

      {authType === 'oauth2' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Token URL"><input value={text(oauth2, 'tokenUrl')} onChange={(e) => updateOAuth2({ tokenUrl: e.target.value })} className="input-sig" placeholder="https://auth.example.com/oauth/token" /></Field>
            <Field label="Scope (optional)"><input value={text(oauth2, 'scope')} onChange={(e) => updateOAuth2({ scope: e.target.value })} className="input-sig" placeholder="read write" /></Field>
          </div>
          <CredentialSection {...vaultPicker} vault={oauth2?.['vault'] as VaultRef | undefined} onVaultChange={(v) => updateOAuth2({ vault: v })} mappingFields={JSON_MAPPING_FIELDS.oauth2}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Client ID"><input value={text(oauth2, 'clientId')} onChange={(e) => updateOAuth2({ clientId: e.target.value })} className="input-sig" autoComplete="off" /></Field>
              <Field label="Client Secret"><input type="password" value={text(oauth2, 'clientSecret')} onChange={(e) => updateOAuth2({ clientSecret: e.target.value })} className="input-sig" autoComplete="new-password" /></Field>
            </div>
          </CredentialSection>
        </>
      )}

      {authType === 'cas' && (
        <>
          <Field label="CAS Server URL"><input value={text(cas, 'casServerUrl')} onChange={(e) => updateCAS({ casServerUrl: e.target.value })} className="input-sig" placeholder="https://cas.example.com/cas" /></Field>
          <CredentialSection {...vaultPicker} vault={cas?.['vault'] as VaultRef | undefined} onVaultChange={(v) => updateCAS({ vault: v })} mappingFields={JSON_MAPPING_FIELDS.cas}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Username"><input value={text(cas, 'username')} onChange={(e) => updateCAS({ username: e.target.value })} className="input-sig" autoComplete="off" /></Field>
              <Field label="Password"><input type="password" value={text(cas, 'password')} onChange={(e) => updateCAS({ password: e.target.value })} className="input-sig" autoComplete="new-password" /></Field>
            </div>
          </CredentialSection>
        </>
      )}
    </div>
  )
}
