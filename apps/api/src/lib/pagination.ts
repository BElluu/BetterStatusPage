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

export interface PaginationQuery {
  page?: string
  limit?: string
}

const DEFAULT_MAX_PAGE = 100_000

function toPagination(page: number, limit: number): Pagination {
  return { page, limit, offset: (page - 1) * limit }
}

/**
 * Lenient paging for admin lists: missing, non-numeric or out-of-range values fall back to the
 * default or are clamped into range, so a hand-edited URL never fails the page.
 */
export function parsePagination(query: PaginationQuery, options: PaginationOptions): Pagination {
  const maxPage = options.maxPage ?? DEFAULT_MAX_PAGE
  const rawPage = Math.floor(Number(query.page ?? 1)) || 1
  const rawLimit = Math.floor(Number(query.limit ?? options.defaultLimit)) || options.defaultLimit
  const page = Math.min(maxPage, Math.max(1, rawPage))
  const limit = Math.min(options.maxLimit, Math.max(1, rawLimit))
  return toPagination(page, limit)
}

/**
 * Strict paging for public endpoints: anything other than an integer within range is rejected
 * (returns null) so callers can answer 400 instead of silently serving a different page.
 */
export function parseStrictPagination(query: PaginationQuery, options: PaginationOptions): Pagination | null {
  const maxPage = options.maxPage ?? DEFAULT_MAX_PAGE
  const page = Number(query.page ?? 1)
  const limit = Number(query.limit ?? options.defaultLimit)
  if (!Number.isInteger(page) || page < 1 || page > maxPage) return null
  if (!Number.isInteger(limit) || limit < 1 || limit > options.maxLimit) return null
  return toPagination(page, limit)
}
