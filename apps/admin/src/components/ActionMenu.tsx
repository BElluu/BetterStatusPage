import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

export interface ActionMenuItem {
  label: string
  icon: string
  /** Runs when chosen; give `to` instead for a link. */
  onSelect?: () => void
  to?: string
  state?: unknown
  danger?: boolean
}

/**
 * A "more" button that opens a small menu. The menu is positioned against the viewport, so a table that scrolls
 * sideways does not clip it. Escape, a click outside, scrolling and resizing close it.
 */
export function ActionMenu({ label, items, icon = 'more_horiz', buttonClassName = 'btn-icon' }: {
  label: string
  items: ActionMenuItem[]
  icon?: string
  buttonClassName?: string
}) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const open = pos !== null

  useEffect(() => {
    if (!open) return
    const close = () => setPos(null)
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); buttonRef.current?.focus() }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  function toggle() {
    if (open) { setPos(null); return }
    const rect = buttonRef.current!.getBoundingClientRect()
    setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
  }

  const itemClass = 'flex w-full items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-container focus-ring'

  return (
    <>
      <button ref={buttonRef} type="button" className={buttonClassName} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>{icon}</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          className="fixed z-50 min-w-40 rounded-lg py-1 shadow-lg"
          style={{ top: pos.top, right: pos.right, background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)' }}
        >
          {items.map((item) => {
            const content = (
              <>
                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>{item.icon}</span>
                {item.label}
              </>
            )
            const style = { color: item.danger ? 'var(--m3-down)' : 'var(--m3-on-surface)' }
            return item.to ? (
              <Link key={item.label} role="menuitem" to={item.to} state={item.state} className={itemClass} style={style} onClick={() => setPos(null)}>{content}</Link>
            ) : (
              <button key={item.label} type="button" role="menuitem" className={itemClass} style={style} onClick={() => { setPos(null); item.onSelect?.() }}>{content}</button>
            )
          })}
        </div>
      )}
    </>
  )
}
