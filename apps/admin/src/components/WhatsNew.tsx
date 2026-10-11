import changelogSource from '../../../../docs/changelog.md?raw'
import packageMetadata from '../../package.json'
import { parseChangelog, releasesBetween, type ReleaseNotes } from '../lib/changelog'
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
    return releasesBetween(parseChangelog(changelog), seen, current)
  } catch {
    return []
  }
}

export function WhatsNew({ releases, onClose }: { releases: ReleaseNotes[]; onClose: () => void }) {
  const newest = releases[0]!.version
  return (
    <ModalShell onClose={onClose} label="What's new" align="top">
      <div className="w-full max-w-lg rounded-2xl my-8" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        <ModalHeader icon="celebration" title={`What's new in ${newest}`} onClose={onClose} />
        <div className="p-6 space-y-5">
          {releases.map((release) => (
            <section key={release.version}>
              {releases.length > 1 && <h4 className="font-headline font-bold text-base mb-2" style={{ color: 'var(--m3-on-surface)' }}>{release.version}</h4>}
              {release.groups.map((group) => (
                <div key={group.heading} className="mb-3">
                  <p className="font-mono uppercase text-xs mb-1" style={{ color: 'var(--m3-outline)', letterSpacing: '0.1em' }}>{group.heading}</p>
                  <ul className="space-y-2">
                    {group.items.map((item) => (
                      <li key={item.title + item.summary} className="font-sans text-sm" style={{ color: 'var(--m3-on-surface)' }}>
                        {item.title && <span className="font-bold">{item.title}. </span>}{item.summary}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
          <div className="flex items-center justify-between gap-2">
            <a href={`${DOCS_URL}/changelog/`} target="_blank" rel="noopener" className="font-sans text-sm" style={{ color: 'var(--m3-primary)' }}>Full changelog</a>
            <button type="button" onClick={onClose} className="btn btn-primary">Got it</button>
          </div>
        </div>
      </div>
    </ModalShell>
  )
}
