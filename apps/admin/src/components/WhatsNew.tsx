import changelogSource from '../../../../docs/changelog.md?raw'
import packageMetadata from '../../package.json'
import { parseChangelog, releasesBetween, summarizeRelease, type ReleaseItem, type ReleaseNotes } from '../lib/changelog'
import { DOCS_URL } from './Tour'
import { ModalHeader, ModalShell } from './ModalShell'

const CURRENT_VERSION = packageMetadata.version
const seenKey = (userId: number) => `bsp-whatsnew-seen-${userId}`

export function markWhatsNewSeen(userId: number): void {
  try { localStorage.setItem(seenKey(userId), CURRENT_VERSION) } catch { /* the notes may show again next visit */ }
}

/**
 * Releases this user has not seen yet. A user with no record (new, or from before this existed) is only
 * marked as up to date, so the first run shows nothing.
 */
export function pendingWhatsNew(userId: number, changelog: string = changelogSource, current: string = CURRENT_VERSION): ReleaseNotes[] {
  try {
    const seen = localStorage.getItem(seenKey(userId))
    if (seen === null) {
      markWhatsNewSeen(userId)
      return []
    }
    return releasesBetween(parseChangelog(changelog), seen, current).filter((release) => release.groups.length > 0)
  } catch {
    return []
  }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** Opening one section closes the others (shared `name`), so the dialog keeps its size. */
function Section({ title, items, defaultOpen }: { title: string; items: ReleaseItem[]; defaultOpen?: boolean }) {
  return (
    <details name="whats-new-sections" open={defaultOpen} className="group rounded-xl" style={{ border: '1px solid var(--m3-outline-variant)' }}>
      <summary className="flex items-center justify-between gap-2 px-4 py-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden font-headline font-semibold text-sm" style={{ color: 'var(--m3-on-surface)' }}>
        <span>{title} <span className="font-mono text-xs" style={{ color: 'var(--m3-outline)' }}>({items.length})</span></span>
        <span aria-hidden="true" className="material-symbols-outlined transition-transform group-open:rotate-180" style={{ fontSize: '20px' }}>expand_more</span>
      </summary>
      <ul className="space-y-2 px-4 pb-3 overflow-y-auto" style={{ maxHeight: '40vh' }}>
        {items.map((item) => (
          <li key={item.title + item.summary} className="font-sans text-sm" style={{ color: 'var(--m3-on-surface)' }}>
            {item.title && <span className="font-bold">{item.title}. </span>}{item.summary}
          </li>
        ))}
      </ul>
    </details>
  )
}

/**
 * The newest release as collapsible sections (the first one with entries open, empty ones left out), earlier ones in one line each.
 * Only one section is open at a time, so the dialog stays small however many entries a release has.
 */
export function WhatsNew({ releases, onClose }: { releases: ReleaseNotes[]; onClose: () => void }) {
  const [latest, ...earlier] = releases.map(summarizeRelease)
  const sections = [
    { title: 'New', items: latest!.added },
    { title: 'Changed', items: latest!.changed },
    { title: 'Fixes', items: latest!.fixed },
  ].filter((section) => section.items.length > 0)
  return (
    <ModalShell onClose={onClose} label="What's new">
      <div className="w-full max-w-lg rounded-2xl" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        <ModalHeader icon="celebration" title={`What's new in ${latest!.version}`} onClose={onClose} />
        <div className="p-6 space-y-3">
          {sections.map((section, index) => <Section key={section.title} title={section.title} items={section.items} defaultOpen={index === 0} />)}
          {earlier.length > 0 && (
            <p className="font-sans text-sm pt-1" style={{ color: 'var(--m3-secondary)' }}>
              Earlier: {earlier.map((release) => `${release.version} (${[
                release.added.length > 0 && `${release.added.length} new`,
                release.changed.length > 0 && plural(release.changed.length, 'change', 'changes'),
                release.fixed.length > 0 && plural(release.fixed.length, 'fix', 'fixes'),
              ].filter(Boolean).join(', ')})`).join(' · ')}
            </p>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <a href={`${DOCS_URL}/changelog/`} target="_blank" rel="noopener" className="btn btn-secondary">Full changelog</a>
            <button type="button" onClick={onClose} className="btn btn-primary">Got it</button>
          </div>
        </div>
      </div>
    </ModalShell>
  )
}
