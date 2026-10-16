import { useEffect, useId, useRef, useState } from 'react'

export type VaultTypeValue = 'local' | 'hashicorp'

/** Only a local vault stores values; every external vault holds references to secrets kept in the provider. */
export const isReferenceVault = (type: VaultTypeValue): boolean => type !== 'local'

/** Icon per vault type, shared by the picker and the vault list so they always match. */
export const VAULT_TYPE_ICONS: Record<VaultTypeValue, string> = { local: 'storage', hashicorp: 'vpn_key' }

interface VaultTypeOption {
  value: VaultTypeValue | null
  label: string
  hint: string
  icon: string
}

/** Vault types in picker order; entries with a null value are announced but cannot be selected yet. */
const VAULT_TYPE_OPTIONS: VaultTypeOption[] = [
  { value: 'local', label: 'Local', hint: 'Encrypted in the BetterStatusPage database', icon: VAULT_TYPE_ICONS.local },
  { value: 'hashicorp', label: 'HashiCorp Vault', hint: 'Read secrets from your own HashiCorp Vault', icon: VAULT_TYPE_ICONS.hashicorp },
  { value: null, label: 'Azure Key Vault', hint: 'Coming soon', icon: 'cloud' },
  { value: null, label: 'GCP Secret Manager', hint: 'Coming soon', icon: 'cloud' },
  { value: null, label: 'AWS Secrets Manager', hint: 'Coming soon', icon: 'cloud' },
]

interface Props {
  value: VaultTypeValue
  onChange: (type: VaultTypeValue) => void
}

function TypeIcon({ icon }: { icon: string }) {
  return (
    <span className="flex-none w-8 h-8 rounded-lg grid place-items-center" style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}>
      <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 20 }}>{icon}</span>
    </span>
  )
}

/** Vault type list in the same dropdown style as the monitor and channel type pickers. */
export function VaultTypePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const labelId = useId()
  const buttonId = useId()
  const selected = VAULT_TYPE_OPTIONS.find((t) => t.value === value)!

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  function pick(option: VaultTypeOption) {
    if (!option.value) return
    setOpen(false)
    buttonRef.current?.focus()
    if (option.value !== value) onChange(option.value)
  }

  return (
    <div ref={rootRef} className="relative">
      <span id={labelId} className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Type</span>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${buttonId}`}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 text-left rounded-xl px-3 py-2 focus-ring"
        style={{ background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)', color: 'var(--m3-on-surface)' }}
      >
        <TypeIcon icon={selected.icon} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{selected.label}</span>
          <span className="block text-xs truncate" style={{ color: 'var(--m3-secondary)' }}>{selected.hint}</span>
        </span>
        <span className="material-symbols-outlined" aria-hidden="true" style={{ color: 'var(--m3-secondary)' }}>unfold_more</span>
      </button>

      {open && (
        <div
          className="absolute z-10 left-0 right-0 mt-1.5 rounded-xl overflow-hidden shadow-xl"
          style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}
        >
          <div role="listbox" aria-labelledby={labelId} className="max-h-72 overflow-auto p-1.5">
            {VAULT_TYPE_OPTIONS.map((t) => {
              const disabled = t.value === null
              const isSelected = t.value === value
              return (
                <button
                  key={t.label}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={disabled}
                  onClick={() => pick(t)}
                  className={`w-full flex items-center gap-3 text-left rounded-lg px-2 py-1.5 focus-ring ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-[var(--m3-surface-container)]'} ${isSelected ? 'selection-active' : ''}`}
                  style={{ border: '1px solid transparent' }}
                >
                  <TypeIcon icon={t.icon} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{t.label}</span>
                    <span className="block text-xs truncate opacity-75">{t.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
