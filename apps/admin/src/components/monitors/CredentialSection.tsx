import type { ReactNode } from 'react'
import type { VaultRef } from '@bsp/shared'
import { Field, Note, type VaultPickerProps } from './monitorFormParts'

interface CredentialSectionProps extends VaultPickerProps {
  vault: VaultRef | undefined
  onVaultChange: (v: VaultRef | undefined) => void
  mappingFields: { key: string; label: string }[]
  /** Optional note shown at the top of the vault/direct section */
  note?: string
  /** Direct-input fields — rendered only when not using vault */
  children: ReactNode
}

/**
 * Wraps a set of credential fields with a Direct / Vault source toggle.
 * In direct mode: shows a warning banner + the credential inputs (children).
 * In vault mode: shows vault → secret dropdowns + JSON field mapping if needed.
 */
export function CredentialSection({
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
          <Note tone="warning">For security, store credentials in Vault rather than entering them directly here.</Note>
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

interface ConnectionStringSectionProps extends VaultPickerProps {
  vault: VaultRef | undefined
  onVaultChange: (v: VaultRef | undefined) => void
}

/**
 * Vault-only picker for SQL Server connection strings.
 * Direct input is intentionally not available — a connection string contains credentials.
 */
export function ConnectionStringSection({
  vault, onVaultChange, vaults, secretsByVault, onLoadSecrets,
}: ConnectionStringSectionProps) {
  const selectedVaultId  = vault?.vaultId
  const selectedSecretId = vault?.secretId
  const fieldMapping     = vault?.fieldMapping ?? {}

  const secrets        = selectedVaultId ? (secretsByVault[selectedVaultId] ?? null) : null
  const selectedSecret = secrets?.find((s) => s.id === selectedSecretId)

  return (
    <div className="space-y-3">
      <Note tone="info">Connection strings contain credentials and must always be stored in Vault.</Note>

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
        <Note tone="warning">
          A <strong>userpass</strong> secret cannot be used as a connection string. Use a <strong>value</strong> or <strong>json</strong> secret instead.
        </Note>
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
