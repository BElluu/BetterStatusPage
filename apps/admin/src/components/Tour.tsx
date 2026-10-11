import { useState } from 'react'
import { ModalShell, ModalHeader } from './ModalShell'

export const DOCS_URL = 'https://docs.betterstatuspage.dev'

interface TourStep {
  /** Nav path this step introduces; the step is skipped when the role cannot see that page. Omit to always show. */
  to?: string
  icon: string
  title: string
  body: string
}

const STEPS: TourStep[] = [
  { icon: 'waving_hand', title: 'Welcome to BetterStatusPage', body: 'A short tour of the admin console. Use the sidebar on the left (the menu button on small screens) to move between pages. You can skip this at any time and replay it later from the sidebar.' },
  { to: '/admin/', icon: 'dashboard', title: 'Dashboard', body: 'The current state of every monitor at a glance, with open incidents and recent activity.' },
  { to: '/admin/monitors', icon: 'radio_button_checked', title: 'Monitors', body: 'Add the services you want to watch: HTTP, TCP, databases and more. Start here, nothing else shows up on the status page without a monitor.' },
  { to: '/admin/notifications', icon: 'notifications', title: 'Notifications', body: 'Choose where alerts go when a monitor fails or recovers: email, Slack, Teams, Discord, Telegram or a webhook.' },
  { to: '/admin/incidents', icon: 'warning', title: 'Incidents and maintenance', body: 'Tell your users what is happening. Post incident updates and schedule maintenance windows, which appear on the public status page.' },
  { to: '/admin/builder', icon: 'dashboard_customize', title: 'Page Builder', body: 'Arrange the public status page by dragging blocks around, and decide which monitors it shows.' },
  { to: '/admin/branding', icon: 'palette', title: 'Branding', body: 'Set the name, logo and colours of the status page so it matches your product.' },
  { to: '/admin/settings', icon: 'manage_accounts', title: 'Settings', body: 'Change your password, turn on two-factor authentication and set date and time formats.' },
  { icon: 'menu_book', title: 'Documentation', body: 'Guides for every feature are at docs.betterstatuspage.dev. The Documentation link in the sidebar is always there.' },
]

interface TourProps {
  /** Nav paths the signed-in role may open. */
  allowedPaths: ReadonlySet<string>
  onClose: () => void
}

/** Step-by-step introduction to the admin console, shown once to each new user and replayable from the sidebar. */
export function Tour({ allowedPaths, onClose }: TourProps) {
  const steps = STEPS.filter((step) => !step.to || step.to === '/admin/settings' || allowedPaths.has(step.to))
  const [index, setIndex] = useState(0)
  const step = steps[index]!
  const last = index === steps.length - 1

  return (
    <ModalShell onClose={onClose} label="Admin console tour">
      <div className="w-full max-w-md rounded-2xl" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        <ModalHeader icon={step.icon} title={step.title} onClose={onClose} />
        <div className="p-6">
          <p className="font-sans text-sm" style={{ color: 'var(--m3-on-surface)' }}>{step.body}</p>
          {last && (
            <a href={DOCS_URL} target="_blank" rel="noopener" className="font-sans text-sm mt-3 inline-block" style={{ color: 'var(--m3-primary)' }}>
              Open the documentation
            </a>
          )}
          <p className="font-mono text-xs mt-5" style={{ color: 'var(--m3-outline)' }}>Step {index + 1} of {steps.length}</p>
          <div className="flex items-center justify-between gap-2 mt-3">
            <button type="button" onClick={onClose} className="btn btn-ghost">{last ? 'Close' : 'Skip tour'}</button>
            <div className="flex gap-2">
              {index > 0 && <button type="button" onClick={() => setIndex(index - 1)} className="btn btn-secondary">Back</button>}
              {last
                ? <button type="button" onClick={onClose} className="btn btn-primary">Finish</button>
                : <button type="button" onClick={() => setIndex(index + 1)} className="btn btn-primary">Next</button>}
            </div>
          </div>
        </div>
      </div>
    </ModalShell>
  )
}

const tourKey = (userId: number) => `bsp-tour-done-${userId}`

export function isTourDone(userId: number): boolean {
  try { return localStorage.getItem(tourKey(userId)) === '1' } catch { return true }
}

export function markTourDone(userId: number): void {
  try { localStorage.setItem(tourKey(userId), '1') } catch { /* tour may repeat next visit */ }
}
