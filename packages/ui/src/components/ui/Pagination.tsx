import type { ReactNode } from 'react'

type PaginationProps = {
  /** 1-based current page. */
  page: number
  onPageChange: (page: number) => void
  /** Text on the left, e.g. "Page 2 of 5 · 93 entries". Defaults to "Page X of Y" when pageCount is known. */
  summary?: ReactNode | undefined
  /** Hide the whole bar when there is only one page (default true; ignored with hasNext). */
  hideWhenSingle?: boolean | undefined
} & (
  | { pageCount: number; hasNext?: never }
  /** For cursor/unknown-total lists: whether a next page exists. */
  | { hasNext: boolean; pageCount?: never }
)

export function Pagination({ page, onPageChange, summary, hideWhenSingle = true, pageCount, hasNext }: PaginationProps) {
  const canPrev = page > 1
  const canNext = pageCount !== undefined ? page < pageCount : Boolean(hasNext)
  if (pageCount !== undefined && hideWhenSingle && pageCount <= 1) return null

  const text = summary ?? (pageCount !== undefined ? `Page ${page} of ${pageCount}` : `Page ${page}`)

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-sm" style={{ color: 'var(--m3-secondary)' }}>{text}</span>
      <div className="flex gap-2">
        <button type="button" onClick={() => onPageChange(page - 1)} disabled={!canPrev} aria-label="Previous page" className="btn btn-outline btn-sm text-sm font-normal">
          ← Prev
        </button>
        <button type="button" onClick={() => onPageChange(page + 1)} disabled={!canNext} aria-label="Next page" className="btn btn-outline btn-sm text-sm font-normal">
          Next →
        </button>
      </div>
    </nav>
  )
}
