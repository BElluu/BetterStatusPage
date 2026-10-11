import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useOutletContext } from 'react-router-dom'

export const DOCS_URL = 'https://docs.betterstatuspage.dev'

/** Layout hands this to its pages so one of them (Settings) can replay the tour. */
export interface TourControl {
  startTour: () => void
}

export function useStartTour(): (() => void) | undefined {
  return useOutletContext<TourControl | null>()?.startTour
}

interface TourStep {
  /** `data-tour` value of the element to point at; omit for a plain card in the middle of the screen. */
  target?: string
  icon: string
  title: string
  body: string
}

/** Steps follow the sidebar from top to bottom, so keep STEPS in the order of the menu in Layout. */
/** Targets that exist for every role; the others are nav paths, shown only when the role may open them. */
const ALWAYS_AVAILABLE = new Set(['/admin/settings', 'docs'])

const STEPS: TourStep[] = [
  { icon: 'waving_hand', title: 'Welcome to BetterStatusPage', body: 'A short tour of the admin console: you will click through the main pages in the sidebar. You can skip it at any time.' },
  { target: '/admin/', icon: 'dashboard', title: 'Dashboard', body: 'The current state of every monitor at a glance, with open incidents and recent activity.' },
  { target: '/admin/monitors', icon: 'radio_button_checked', title: 'Monitors', body: 'Add the services you want to watch: HTTP, TCP, databases and more. Nothing shows up on the status page without a monitor.' },
  { target: '/admin/incidents', icon: 'warning', title: 'Incidents', body: 'Tell your users what is happening. Incident updates appear on the public status page.' },
  { target: '/admin/maintenance', icon: 'construction', title: 'Maintenance', body: 'Schedule maintenance windows so planned downtime is announced instead of alerting.' },
  { target: '/admin/notifications', icon: 'notifications', title: 'Notifications', body: 'Choose where alerts go when a monitor fails or recovers: email, Slack, Teams, Discord, Telegram or a webhook.' },
  { target: '/admin/builder', icon: 'dashboard_customize', title: 'Page Builder', body: 'Arrange the public status page by dragging blocks around, and decide which monitors it shows.' },
  { target: '/admin/branding', icon: 'palette', title: 'Branding', body: 'Set the name, logo and colours of the status page so it matches your product.' },
  { target: 'docs', icon: 'menu_book', title: 'Documentation', body: 'Guides for every feature live at docs.betterstatuspage.dev. This link is always in the sidebar.' },
  { target: '/admin/settings', icon: 'manage_accounts', title: 'Settings', body: 'Change your password, turn on two-factor authentication, set date and time formats, and replay this tour.' },
  { icon: 'check_circle', title: "You're all set", body: 'Start with Monitors: add the first service you want to watch.' },
]

interface Rect { top: number; left: number; width: number; height: number }

const HOLE_PADDING = 4
const CARD_WIDTH = 340
const Z_INDEX = 10000

function findVisible(target: string): HTMLElement | null {
  const matches = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`))
  return matches.find((element) => element.getClientRects().length > 0) ?? null
}

/**
 * Follows the element for `target` every frame, so scrolling, resizing, the drawer animation and page changes
 * need no separate handling. When the element is not on screen (the mobile drawer is closed) it asks for it once.
 */
function useTargetRect(target: string | undefined, revealTarget: () => void): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null)
  const revealRef = useRef(revealTarget)
  useEffect(() => { revealRef.current = revealTarget })

  useEffect(() => {
    setRect(null)
    if (!target) return
    let frame = 0
    let revealed = false
    let scrolled = false
    const follow = () => {
      const element = findVisible(target)
      if (element) {
        if (!scrolled) { scrolled = true; element.scrollIntoView?.({ block: 'nearest' }) }
        const box = element.getBoundingClientRect()
        const next = { top: box.top, left: box.left, width: box.width, height: box.height }
        setRect((prev) => prev && prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.height === next.height ? prev : next)
      } else {
        setRect(null)
        if (!revealed) { revealed = true; revealRef.current() }
      }
      frame = requestAnimationFrame(follow)
    }
    follow()
    return () => cancelAnimationFrame(frame)
  }, [target])

  return rect
}

function cardPosition(rect: Rect | null): CSSProperties {
  if (!rect) return { left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: `min(${CARD_WIDTH}px, calc(100vw - 32px))` }
  const beside = rect.left + rect.width + HOLE_PADDING + 16
  if (beside + CARD_WIDTH + 16 <= window.innerWidth) {
    return { left: beside, top: Math.max(16, Math.min(rect.top - 8, window.innerHeight - 260)), width: CARD_WIDTH }
  }
  return rect.top > window.innerHeight / 2 ? { left: 16, right: 16, top: 16 } : { left: 16, right: 16, bottom: 16 }
}

interface TourProps {
  /** Nav paths the signed-in role may open. */
  allowedPaths: ReadonlySet<string>
  /** Opens the mobile navigation drawer when the sidebar is hidden. */
  openDrawer: () => void
  onClose: () => void
}

/**
 * Walks a new user through the sidebar: the target item is lit up, everything else is dimmed and inert, and
 * clicking the item itself (which also opens its page) moves to the next step. Next works too, for keyboards.
 */
export function Tour({ allowedPaths, openDrawer, onClose }: TourProps) {
  const steps = STEPS.filter((step) => !step.target || ALWAYS_AVAILABLE.has(step.target) || allowedPaths.has(step.target))
  const [index, setIndex] = useState(0)
  const step = steps[index]!
  const last = index === steps.length - 1
  const rect = useTargetRect(step.target, openDrawer)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  useEffect(() => {
    const target = step.target
    const onClick = (event: MouseEvent) => {
      const element = target ? findVisible(target) : null
      if (element && event.target instanceof Node && element.contains(event.target)) setIndex((i) => i + 1)
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onCloseRef.current() }
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [step.target])

  const hole = rect && {
    top: rect.top - HOLE_PADDING,
    left: rect.left - HOLE_PADDING,
    width: rect.width + HOLE_PADDING * 2,
    height: rect.height + HOLE_PADDING * 2,
  }
  const blocker = { position: 'fixed', background: 'transparent', pointerEvents: 'auto' } as const

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: Z_INDEX, pointerEvents: 'none' }}>
      {hole ? (
        <>
          <div data-testid="tour-spotlight" style={{ position: 'fixed', ...hole, borderRadius: 12, border: '2px solid var(--m3-primary)', boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }} />
          <div style={{ ...blocker, top: 0, left: 0, right: 0, height: Math.max(0, hole.top) }} />
          <div style={{ ...blocker, top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} />
          <div style={{ ...blocker, top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height }} />
          <div style={{ ...blocker, top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} />
        </>
      ) : (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', pointerEvents: 'auto' }} />
      )}

      <div
        role="dialog"
        aria-label="Admin console tour"
        className="rounded-2xl p-5"
        style={{ position: 'fixed', pointerEvents: 'auto', background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)', boxShadow: '0 8px 32px rgba(0,0,0,0.25)', ...cardPosition(rect) }}
      >
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined shrink-0" aria-hidden="true" style={{ fontSize: '22px', color: 'var(--m3-primary)' }}>{step.icon}</span>
          <h3 className="font-headline font-bold text-lg" style={{ color: 'var(--m3-on-surface)' }}>{step.title}</h3>
        </div>
        <p className="font-sans text-sm mt-3" style={{ color: 'var(--m3-on-surface)' }}>{step.body}</p>
        <p className="font-mono text-xs mt-4" style={{ color: 'var(--m3-outline)' }}>Step {index + 1} of {steps.length}</p>
        <div className="flex items-center justify-between gap-2 mt-3">
          <button type="button" onClick={onClose} className="btn btn-ghost">{last ? 'Close' : 'Skip tour'}</button>
          {last
            ? <button type="button" onClick={onClose} className="btn btn-primary">Finish</button>
            : <button type="button" onClick={() => setIndex(index + 1)} className="btn btn-secondary">{index === 0 ? 'Start' : 'Next'}</button>}
        </div>
      </div>
    </div>
  )
}

const tourKey = (userId: number) => `bsp-tour-done-${userId}`

export function isTourDone(userId: number): boolean {
  try { return localStorage.getItem(tourKey(userId)) === '1' } catch { return true }
}

export function markTourDone(userId: number): void {
  try { localStorage.setItem(tourKey(userId), '1') } catch { /* tour may repeat next visit */ }
}
