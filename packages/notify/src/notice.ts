/** How serious an event is; the rich channels paint it in a colour family and the push channels map it to a priority. */
export type NoticeSeverity = 'critical' | 'warning' | 'ok'

/**
 * A piece of a headline. Plain text stays as written; a `subject` (what the event is about) and a `state` (what became
 * of it) are the parts a channel emphasises in its own markup. A `kind` names what sort of thing the subject is
 * ("Server"), which a channel may leave out where its title is already crowded.
 */
export type NoticeSegment = string | { kind: string } | { subject: string } | { state: string }

export interface NoticeFact {
  label: string
  value: string
  /** The label for channels that have room for a longer one. */
  fullLabel?: string
}

/**
 * What the channels say about one event, independent of the application that raised it. The application builds it
 * from its own variables; every channel turns it into its own payload.
 */
export interface Notice {
  severity: NoticeSeverity
  headline: NoticeSegment[]
  /** The line under the headline in channels that have one. */
  subtitle: NoticeSegment[]
  facts: NoticeFact[]
  /** The error or details of the event, shown after the facts. */
  detail?: { label: string; value: string }
  /** When the event happened, as an ISO instant (anything else is shown as is). */
  at: string
  /** Names `at` in the footer ("Checked at"). */
  atLabel: string
}

/** How a channel writes the emphasised segments of a headline. */
export interface SegmentMarkup {
  /** Applied to every text segment, emphasised or not. */
  text?: (value: string) => string
  /** Defaults to writing the kind as plain text. */
  kind?: (value: string) => string
  subject: (value: string) => string
  state: (value: string) => string
}

export function renderSegments(segments: NoticeSegment[], markup: SegmentMarkup): string {
  const text = markup.text ?? ((value: string) => value)
  return segments.map((segment) => {
    if (typeof segment === 'string') return text(segment)
    if ('kind' in segment) return markup.kind ? markup.kind(text(segment.kind)) : text(segment.kind)
    if ('subject' in segment) return markup.subject(text(segment.subject))
    return markup.state(text(segment.state))
  }).join('')
}

const plainMarkup: SegmentMarkup = { subject: (value) => value, state: (value) => value }

/** A headline without any markup. */
export function plainSegments(segments: NoticeSegment[]): string {
  return renderSegments(segments, plainMarkup)
}

/** "2026-10-09T17:00:22.988Z" → "2026-10-09 17:00:22 UTC"; anything that is not an ISO instant is shown as is. */
export function readableTimestamp(iso: string | undefined): string {
  if (!iso) return 'unknown'
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/.exec(iso)
  return match ? `${match[1]} ${match[2]} UTC` : iso
}
