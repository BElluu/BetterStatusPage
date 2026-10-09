import { useEffect, useId, useRef, useState } from 'react'
import { CHANNEL_TYPES, CHANNEL_TYPE_ORDER, type ChannelType } from './channelTypes'

interface Props {
  value: ChannelType
  onChange: (type: ChannelType) => void
}

function TypeIcon({ type }: { type: ChannelType }) {
  return (
    <span className="flex-none w-8 h-8 rounded-lg grid place-items-center" style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}>
      {CHANNEL_TYPES[type].icon(18)}
    </span>
  )
}

/** Searchable channel type list: stays one control tall however many types exist. */
export function ChannelTypePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const labelId = useId()
  const buttonId = useId()
  const selected = CHANNEL_TYPES[value]

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
  const matches = CHANNEL_TYPE_ORDER.filter((id) => !needle || `${CHANNEL_TYPES[id].label} ${CHANNEL_TYPES[id].hint}`.toLowerCase().includes(needle))

  function pick(type: ChannelType) {
    setOpen(false)
    buttonRef.current?.focus()
    if (type !== value) onChange(type)
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
        <TypeIcon type={value} />
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
              placeholder="Search channel types"
              aria-label="Search channel types"
              className="flex-1 min-w-0 bg-transparent text-sm outline-none"
              style={{ color: 'var(--m3-on-surface)' }}
            />
          </div>
          <div role="listbox" aria-labelledby={labelId} className="max-h-72 overflow-auto p-1.5">
            {matches.length === 0 && <p className="p-4 text-center text-sm" style={{ color: 'var(--m3-secondary)' }}>No channel type matches “{query.trim()}”.</p>}
            {matches.map((id) => {
              const isSelected = id === value
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => pick(id)}
                  className={`w-full flex items-center gap-3 text-left rounded-lg px-2 py-1.5 focus-ring hover:bg-[var(--m3-surface-container)] ${isSelected ? 'selection-active' : ''}`}
                  style={{ border: '1px solid transparent' }}
                >
                  <TypeIcon type={id} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{CHANNEL_TYPES[id].label}</span>
                    <span className="block text-xs truncate opacity-75">{CHANNEL_TYPES[id].hint}</span>
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
