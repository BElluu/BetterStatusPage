import { useEffect, useId, useRef, useState } from 'react'
import type { MonitorType } from '@bsp/shared'
import { MONITOR_TYPES, type MonitorTypeOption } from './monitorTypes'

interface Props {
  value: MonitorType
  onChange: (type: MonitorType) => void
}

function TypeIcon({ icon }: { icon: string }) {
  return (
    <span className="flex-none w-8 h-8 rounded-lg grid place-items-center" style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}>
      <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 20 }}>{icon}</span>
    </span>
  )
}

/** Searchable, grouped monitor type list: stays one control tall however many types exist. */
export function MonitorTypePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const labelId = useId()
  const buttonId = useId()
  const selected = MONITOR_TYPES.find((t) => (t.types ?? [t.value]).includes(value)) ?? MONITOR_TYPES[0]!

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

  const needle = query.trim().toLowerCase()
  const matches = MONITOR_TYPES.filter((t) => !needle || `${t.label} ${t.hint} ${t.group}`.toLowerCase().includes(needle))
  const groups = matches.reduce<{ name: string; items: MonitorTypeOption[] }[]>((acc, t) => {
    const group = acc.find((g) => g.name === t.group)
    if (group) group.items.push(t)
    else acc.push({ name: t.group, items: [t] })
    return acc
  }, [])

  function pick(option: MonitorTypeOption) {
    setOpen(false)
    buttonRef.current?.focus()
    if (!(option.types ?? [option.value]).includes(value)) onChange(option.value)
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
        onClick={() => { setQuery(''); setOpen((o) => !o) }}
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
          <div className="flex items-center gap-2 px-3 py-2.5" style={{ borderBottom: '1px solid var(--m3-outline-variant)', color: 'var(--m3-secondary)' }}>
            <span className="material-symbols-outlined" aria-hidden="true">search</span>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search monitor types"
              aria-label="Search monitor types"
              className="flex-1 min-w-0 bg-transparent text-sm outline-none"
              style={{ color: 'var(--m3-on-surface)' }}
            />
          </div>
          <div role="listbox" aria-labelledby={labelId} className="max-h-72 overflow-auto p-1.5">
            {groups.length === 0 && <p className="p-4 text-center text-sm" style={{ color: 'var(--m3-secondary)' }}>No monitor type matches “{query.trim()}”.</p>}
            {groups.map((g) => (
              <div key={g.name} role="group" aria-label={g.name}>
                <div className="px-2 pt-2.5 pb-1 font-mono text-[11px] uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>{g.name}</div>
                {g.items.map((t) => {
                  const isSelected = t.value === selected.value
                  return (
                    <button
                      key={t.value}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => pick(t)}
                      className={`w-full flex items-center gap-3 text-left rounded-lg px-2 py-1.5 focus-ring hover:bg-[var(--m3-surface-container)] ${isSelected ? 'selection-active' : ''}`}
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
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
