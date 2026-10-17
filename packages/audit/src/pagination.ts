export interface Pagination {
  page: number
  limit: number
  offset: number
}

export interface PaginationOptions {
  defaultLimit: number
  maxLimit: number
  /** Highest page accepted; keeps OFFSET within a sane range. */
  maxPage?: number
}

const DEFAULT_MAX_PAGE = 100_000

/**
 * Lenient paging for admin lists: missing, non-numeric or out-of-range values fall back to the
 * default or are clamped into range, so a hand-edited URL never fails the page.
 */
export function parsePagination(query: { page?: string; limit?: string }, options: PaginationOptions): Pagination {
  const maxPage = options.maxPage ?? DEFAULT_MAX_PAGE
  const rawPage = Math.floor(Number(query.page ?? 1)) || 1
  const rawLimit = Math.floor(Number(query.limit ?? options.defaultLimit)) || options.defaultLimit
  const page = Math.min(maxPage, Math.max(1, rawPage))
  const limit = Math.min(options.maxLimit, Math.max(1, rawLimit))
  return { page, limit, offset: (page - 1) * limit }
}
