export interface ReleaseItem {
  title: string
  summary: string
}

export interface ReleaseGroup {
  heading: string
  items: ReleaseItem[]
}

export interface ReleaseNotes {
  version: string
  date: string
  groups: ReleaseGroup[]
}

const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+)\](?: - (\S+))?\s*$/
const GROUP_HEADING = /^### (.+?)\s*$/
const ITEM = /^- (?:\*\*(.+?)\*\*:?\s*)?(.*)$/

function plain(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').trim()
}

function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(?:\s|$)/.exec(text)
  return plain(match ? match[1]! : text)
}

/**
 * Released sections of docs/changelog.md, newest first; each top-level bullet is cut down to its bold title and
 * the first sentence of its text. The Unreleased section and nested bullets are left out.
 */
export function parseChangelog(markdown: string): ReleaseNotes[] {
  const releases: ReleaseNotes[] = []
  let release: ReleaseNotes | null = null
  let group: ReleaseGroup | null = null
  for (const line of markdown.split(/\r?\n/)) {
    const releaseMatch = RELEASE_HEADING.exec(line)
    if (releaseMatch) {
      release = { version: releaseMatch[1]!, date: releaseMatch[2] ?? '', groups: [] }
      releases.push(release)
      group = null
    } else if (line.startsWith('## ')) {
      release = null
    } else if (release) {
      const groupMatch = GROUP_HEADING.exec(line)
      if (groupMatch) {
        group = { heading: groupMatch[1]!, items: [] }
        release.groups.push(group)
        continue
      }
      const item = group ? ITEM.exec(line) : null
      if (item && group) group.items.push({ title: plain(item[1] ?? ''), summary: firstSentence(item[2] ?? '') })
    }
  }
  return releases.map((r) => ({ ...r, groups: r.groups.filter((g) => g.items.length > 0) }))
}

/** Negative, zero or positive like a sort comparator; plain x.y.z versions only. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Releases after `seen` up to and including `current`, newest first. */
export function releasesBetween(releases: ReleaseNotes[], seen: string, current: string): ReleaseNotes[] {
  return releases.filter((r) => compareVersions(r.version, seen) > 0 && compareVersions(r.version, current) <= 0)
}
