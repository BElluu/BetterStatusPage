import { useState } from 'react'
import type { MonitorTag } from '@bsp/shared'

/** Tags currently on the monitor, removable, plus a row to add new or existing ones. */
export function TagsSection({ tags, allTags, onChange }: { tags: MonitorTag[]; allTags: MonitorTag[]; onChange: (tags: MonitorTag[]) => void }) {
  return (
    <div className="space-y-3">
      {tags.length === 0 && <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No tags yet.</p>}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t, i) => (
            <span key={i} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: `${t.color}22`, color: t.color, border: `1px solid ${t.color}55` }}>
              {t.label}
              <button type="button" onClick={() => onChange(tags.filter((_, j) => j !== i))} className="leading-none opacity-60 hover:opacity-100">×</button>
            </span>
          ))}
        </div>
      )}
      <AddTagRow
        existingTags={allTags.filter((t) => !tags.find((cur) => cur.label === t.label))}
        onAdd={(tag) => { if (!tags.find((t) => t.label === tag.label)) onChange([...tags, tag]) }}
      />
    </div>
  )
}

// Tag colours are user data stored with each tag, not theme colours, so they stay literal.
const TAG_PALETTE = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316',
  '#f59e0b', '#10b981', '#14b8a6', '#06b6d4', '#3b82f6',
]

function AddTagRow({ onAdd, existingTags = [] }: { onAdd: (t: MonitorTag) => void; existingTags?: MonitorTag[] }) {
  const [label, setLabel] = useState('')
  const [color, setColor] = useState(TAG_PALETTE[0]!)
  const [open, setOpen] = useState(false)

  const suggestions = label.trim()
    ? existingTags.filter((t) => t.label.toLowerCase().includes(label.toLowerCase()))
    : []

  function selectSuggestion(t: MonitorTag) {
    onAdd(t)
    setLabel('')
    setOpen(false)
  }

  function add() {
    if (!label.trim()) return
    onAdd({ label: label.trim(), color })
    setLabel('')
    setOpen(false)
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="relative" style={{ flex: '1 1 120px', minWidth: 0 }}>
        <input
          value={label}
          onChange={(e) => { setLabel(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder="Tag label…"
          className="input-sig text-sm w-full"
        />
        {open && suggestions.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 rounded-lg z-50 overflow-hidden"
            style={{ background: 'var(--m3-surface-container-high)', border: '1px solid var(--m3-outline-variant)', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
            {suggestions.map((t) => (
              <button key={t.label} type="button"
                onMouseDown={() => selectSuggestion(t)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left"
                style={{ color: 'var(--m3-on-surface)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--m3-surface-container)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
              >
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: t.color }} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex gap-1.5 flex-shrink-0">
        {TAG_PALETTE.map((c) => (
          <button key={c} type="button" onClick={() => setColor(c)}
            className="w-5 h-5 rounded-full transition-all"
            style={{
              background: c,
              transform: color === c ? 'scale(1.3)' : 'scale(1)',
              outline: color === c ? `2px solid ${c}` : 'none',
              outlineOffset: '2px',
            }}
          />
        ))}
      </div>
      <button type="button" onClick={add}
        className="text-xs px-3 py-1.5 rounded-lg font-semibold flex-shrink-0"
        style={{ background: 'var(--m3-primary-fixed)', color: 'var(--m3-primary)', border: '1px solid color-mix(in srgb, var(--m3-primary) 25%, transparent)' }}
      >Add</button>
    </div>
  )
}
