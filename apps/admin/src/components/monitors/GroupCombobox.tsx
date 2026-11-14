import { useEffect, useRef, useState } from 'react'

interface Props {
  id: string
  value: string
  groups: string[]
  onChange: (group: string) => void
}

/** Text field with a list of the groups in use: pick one, or type a name that does not exist yet and save it. */
export function GroupCombobox({ id, value, groups, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = `${id}-list`

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const typed = value.trim()
  const needle = typed.toLowerCase()
  const matches = groups.filter((g) => !needle || g.toLowerCase().includes(needle))
  // Groups are told apart by their exact name, so "acme" is a new group next to "Acme".
  const isNew = typed !== '' && !groups.includes(typed)

  function pick(group: string) {
    onChange(group)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        value={value}
        maxLength={60}
        placeholder={groups.length > 0 ? 'Choose a group or type a new one' : 'Type a group name'}
        onChange={(e) => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) }
          // Enter confirms the open list instead of saving the form.
          else if (e.key === 'Enter' && open) { e.preventDefault(); setOpen(false) }
        }}
        className="input-sig pr-10"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? 'Hide groups' : 'Show groups'}
        onClick={() => setOpen((o) => !o)}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md focus-ring"
        style={{ color: 'var(--m3-secondary)' }}
      >
        <span className="material-symbols-outlined" aria-hidden="true" style={{ display: 'block' }}>unfold_more</span>
      </button>

      {open && (matches.length > 0 || isNew) && (
        <div
          id={listId}
          role="listbox"
          aria-label="Groups"
          className="absolute z-10 left-0 right-0 mt-1.5 max-h-60 overflow-auto rounded-xl p-1.5 shadow-xl"
          style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}
        >
          {matches.map((g) => (
            <button
              key={g}
              type="button"
              role="option"
              aria-selected={g === typed}
              onClick={() => pick(g)}
              className={`w-full text-left rounded-lg px-3 py-1.5 text-sm focus-ring hover:bg-[var(--m3-surface-container)] ${g === typed ? 'selection-active' : ''}`}
              style={{ color: 'var(--m3-on-surface)', border: '1px solid transparent' }}
            >
              {g}
            </button>
          ))}
          {isNew && (
            <button
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => pick(typed)}
              className="w-full flex items-center gap-2 text-left rounded-lg px-3 py-1.5 text-sm focus-ring hover:bg-[var(--m3-surface-container)]"
              style={{ color: 'var(--m3-on-surface)', border: '1px solid transparent' }}
            >
              <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px', color: 'var(--m3-secondary)' }}>add</span>
              New group “{typed}”
            </button>
          )}
        </div>
      )}
    </div>
  )
}
