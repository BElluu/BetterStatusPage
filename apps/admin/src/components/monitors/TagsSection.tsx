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
              <button type="button" onClick={() => onChange(tags.filter((_, j) => j !== i))} aria-label={`Remove tag ${t.label}`} title="Remove tag" className="leading-none opacity-60 hover:opacity-100 rounded-full focus-ring">×</button>
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
const TAG_COLOUR_NAMES: Record<string, string> = {
  '#6366f1': 'Indigo', '#8b5cf6': 'Violet', '#ec4899': 'Pink', '#ef4444': 'Red', '#f97316': 'Orange',
  '#f59e0b': 'Amber', '#10b981': 'Emerald', '#14b8a6': 'Teal', '#06b6d4': 'Cyan', '#3b82f6': 'Blue',
}

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
          aria-label="Tag label"
          className="input-sig text-sm w-full"
        />
        {open && suggestions.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 rounded-lg z-50 overflow-hidden"
            style={{ background: 'var(--m3-surface-container-high)', border: '1px solid var(--m3-outline-variant)', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
            {suggestions.map((t) => (
              <button key={t.label} type="button"
                onMouseDown={() => selectSuggestion(t)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-container"
                style={{ color: 'var(--m3-on-surface)' }}
              >
                <span className="w-3 h-3 rounded-full flex-shrink-0" aria-hidden="true" style={{ background: t.color }} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 flex-shrink-0" role="group" aria-label="Tag colour">
        {TAG_PALETTE.map((c) => (
          <button key={c} type="button" onClick={() => setColor(c)}
            aria-label={TAG_COLOUR_NAMES[c] ?? c}
            aria-pressed={color === c}
            title={TAG_COLOUR_NAMES[c] ?? c}
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
        className="text-xs px-3 py-1.5 rounded-lg font-semibold flex-shrink-0 focus-ring"
        style={{ background: 'var(--m3-primary-fixed)', color: 'var(--m3-primary)', border: '1px solid color-mix(in srgb, var(--m3-primary) 25%, transparent)' }}
      >Add</button>
    </div>
  )
}
