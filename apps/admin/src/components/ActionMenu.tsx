import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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

/** Where the button is, in viewport coordinates; the menu is placed against it. */
interface Spot { top: number; bottom: number; right: number }

const GAP = 4

/**
 * A "more" button that opens a small menu. The menu is drawn in `document.body` with fixed coordinates, because the
 * page content sits in a scrolling, animated container that would otherwise become its containing block and clip it.
 * It opens below the button, or above it when there is no room. Arrow keys, Home and End move between the items;
 * Escape, Tab, a click outside, scrolling the page and resizing close it, and focus goes back to the button.
 */
export function ActionMenu({ label, items, icon = 'more_horiz', buttonClassName = 'btn-icon' }: {
  label: string
  items: ActionMenuItem[]
  icon?: string
  buttonClassName?: string
}) {
  const [spot, setSpot] = useState<Spot | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const open = spot !== null

  const close = (returnFocus: boolean) => {
    setSpot(null)
    if (returnFocus) buttonRef.current?.focus()
  }

  // Flip above the button when the menu would run past the bottom edge and fits above.
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!spot || !menu) return
    const height = menu.offsetHeight
    const above = spot.bottom + GAP + height > window.innerHeight && spot.top - GAP - height >= 0
    menu.style.top = `${above ? spot.top - GAP - height : spot.bottom + GAP}px`
  }, [spot])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setSpot(null)
    }
    // Capture phase, so a dialog around the menu does not also see the Escape that closes the menu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close(true)
    }
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) setSpot(null)
    }
    const onResize = () => setSpot(null)
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  function toggle() {
    if (open) { setSpot(null); return }
    const rect = buttonRef.current!.getBoundingClientRect()
    setSpot({ top: rect.top, bottom: rect.bottom, right: window.innerWidth - rect.right })
  }

  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Tab') { e.preventDefault(); close(true); return }
    const entries = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const at = entries.indexOf(document.activeElement as HTMLElement)
    const target = e.key === 'ArrowDown' ? entries[(at + 1) % entries.length]
      : e.key === 'ArrowUp' ? entries[(at - 1 + entries.length) % entries.length]
      : e.key === 'Home' ? entries[0]
      : e.key === 'End' ? entries[entries.length - 1]
      : undefined
    if (target) { e.preventDefault(); target.focus() }
  }

  const itemClass = 'flex w-full items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-container focus-ring'

  return (
    <>
      <button ref={buttonRef} type="button" className={buttonClassName} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>{icon}</span>
      </button>
      {spot && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className="fixed z-50 min-w-40 rounded-lg py-1 shadow-lg"
          style={{ top: spot.bottom + GAP, right: spot.right, background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)' }}
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
              <Link key={item.label} role="menuitem" to={item.to} state={item.state} className={itemClass} style={style} onClick={() => close(false)}>{content}</Link>
            ) : (
              <button key={item.label} type="button" role="menuitem" className={itemClass} style={style} onClick={() => { close(true); item.onSelect?.() }}>{content}</button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}
