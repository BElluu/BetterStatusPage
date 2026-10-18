import {
  createContext, useCallback, useContext, useMemo, useRef, useState,
  type KeyboardEvent, type PointerEvent, type ReactNode, type TableHTMLAttributes, type ThHTMLAttributes,
} from 'react'

export const MIN_COLUMN_WIDTH = 60
export const MAX_COLUMN_WIDTH = 600
const KEY_STEP = 16

interface ResizeHandleProps {
  /** Column name, used for the accessible description. */
  label: string
  /** Current width in px; shown to assistive technology. */
  width: number | undefined
  /** Reads the width the column has right now; called when a drag starts and for key presses. */
  measure: () => number
  onResize: (width: number) => void
  /** Restores the default width. */
  onReset: () => void
}

/** Grip on the right edge of a column header: drag, arrow keys, double-click or Home to reset. Place it in a `position: relative` header cell. */
export function ResizeHandle({ label, width, measure, onResize, onReset }: ResizeHandleProps) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)
  const clamp = (w: number) => Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(w)))

  function onPointerDown(e: PointerEvent<HTMLSpanElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startWidth: measure() }
  }

  function onPointerMove(e: PointerEvent<HTMLSpanElement>) {
    if (drag.current) onResize(clamp(drag.current.startWidth + e.clientX - drag.current.startX))
  }

  function onKeyDown(e: KeyboardEvent<HTMLSpanElement>) {
    if (e.key === 'ArrowLeft') onResize(clamp(measure() - KEY_STEP))
    else if (e.key === 'ArrowRight') onResize(clamp(measure() + KEY_STEP))
    else if (e.key === 'Home') onReset()
    else return
    e.preventDefault()
  }

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-description={`Resize ${label} column`}
      aria-valuenow={width}
      aria-valuemin={MIN_COLUMN_WIDTH}
      aria-valuemax={MAX_COLUMN_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => { drag.current = null }}
      onPointerCancel={() => { drag.current = null }}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className="group focus-ring absolute top-0 right-0 z-10 flex h-full w-3 cursor-col-resize touch-none select-none justify-center"
    >
      <span
        aria-hidden="true"
        className="block h-full w-px opacity-60 transition-all group-hover:w-0.5 group-hover:opacity-100 group-focus-visible:w-0.5 group-focus-visible:opacity-100 group-active:w-0.5 group-active:opacity-100"
        style={{ background: 'var(--m3-outline-variant)' }}
      />
    </span>
  )
}

export type SortDirection = 'asc' | 'desc'
export type SortValue = string | number | boolean | null | undefined

export interface TableSort {
  key: string | null
  dir: SortDirection
  /** Sorts by the column; repeated calls on the same column go ascending, descending, then back to the original order. */
  toggle: (key: string) => void
}

const isEmpty = (v: SortValue) => v == null || v === ''

function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/** Sorts `rows` by the column picked in a `DataTable` header. `accessors` maps a column key to the value to compare; empty values always go last. */
export function useTableSort<T>(
  rows: readonly T[],
  accessors: Readonly<Record<string, (row: T) => SortValue>>,
  initial?: { key: string; dir?: SortDirection },
): { rows: T[]; sort: TableSort } {
  const [key, setKey] = useState<string | null>(initial?.key ?? null)
  const [dir, setDir] = useState<SortDirection>(initial?.dir ?? 'asc')

  const toggle = useCallback((next: string) => {
    if (key !== next) { setKey(next); setDir('asc') }
    else if (dir === 'asc') setDir('desc')
    else { setKey(null); setDir('asc') }
  }, [key, dir])

  // The accessors are declared inline by callers; the rows, column and direction are what change the order.
  const accessorsRef = useRef(accessors)
  accessorsRef.current = accessors

  const sorted = useMemo(() => {
    const get = key === null ? undefined : accessorsRef.current[key]
    if (!get) return [...rows]
    const sign = dir === 'asc' ? 1 : -1
    return [...rows].sort((x, y) => {
      const a = get(x), b = get(y)
      if (isEmpty(a) || isEmpty(b)) return Number(isEmpty(a)) - Number(isEmpty(b))
      return sign * compareValues(a, b)
    })
  }, [rows, key, dir])

  return { rows: sorted, sort: useMemo(() => ({ key, dir, toggle }), [key, dir, toggle]) }
}

interface TableContext {
  sort: TableSort | undefined
  widths: number[] | null
  resize: (row: HTMLTableRowElement, index: number, width: number) => void
  reset: () => void
}

const DataTableContext = createContext<TableContext | null>(null)

interface DataTableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** From `useTableSort`; without it the headers are not sortable. */
  sort?: TableSort
  children: ReactNode
}

/**
 * `<table>` whose `DataTh` headers can be sorted and resized. The first resize fixes every column at its
 * current width; a drag then moves the boundary to the next column, so the other columns stay where they are.
 */
export function DataTable({ sort, children, style, className, ...rest }: DataTableProps) {
  const [widths, setWidths] = useState<number[] | null>(null)

  const resize = useCallback((row: HTMLTableRowElement, index: number, width: number) => {
    setWidths((current) => {
      const next = current ? [...current] : Array.from(row.cells, (cell) => cell.offsetWidth)
      const own = next[index]
      if (own === undefined) return current
      const neighbour = next[index + 1]
      let delta = width - own
      if (neighbour !== undefined) delta = Math.min(delta, neighbour - MIN_COLUMN_WIDTH)
      next[index] = own + delta
      if (neighbour !== undefined) next[index + 1] = neighbour - delta
      return next
    })
  }, [])

  const context = useMemo<TableContext>(
    () => ({ sort, widths, resize, reset: () => setWidths(null) }),
    [sort, widths, resize],
  )

  return (
    <DataTableContext.Provider value={context}>
      <table
        {...rest}
        className={`${className ?? ''} ${widths ? '[&_td]:break-words [&_th]:overflow-hidden' : ''}`}
        style={widths ? { ...style, tableLayout: 'fixed', width: widths.reduce((a, b) => a + b, 0), minWidth: 0 } : style}
      >
        {widths && <colgroup>{widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>}
        {children}
      </table>
    </DataTableContext.Provider>
  )
}

interface DataThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** Column key from `useTableSort`'s accessors; makes the header a sort button. */
  sortKey?: string
  /** Set false for columns without a title, such as the row actions. */
  resizable?: boolean
}

/** `<th>` for a `DataTable`: sortable with `sortKey`, resizable unless `resizable={false}`. Give it the classes and colours you would give a `<th>`. */
export function DataTh({ sortKey, resizable = true, children, className, style, ...rest }: DataThProps) {
  const table = useContext(DataTableContext)
  const ref = useRef<HTMLTableCellElement>(null)
  const sorted = sortKey !== undefined && table?.sort?.key === sortKey
  const dir = table?.sort?.dir
  const label = typeof children === 'string' ? children : sortKey ?? 'this'

  return (
    <th
      ref={ref}
      {...rest}
      aria-sort={sorted ? (dir === 'asc' ? 'ascending' : 'descending') : rest['aria-sort']}
      className={`${className ?? ''} ${resizable && table ? 'relative' : ''}`}
      style={sorted ? { ...style, color: 'var(--m3-primary)' } : style}
    >
      {sortKey !== undefined && table?.sort ? (
        <button
          type="button"
          onClick={() => table.sort?.toggle(sortKey)}
          className="inline-flex items-center gap-1 uppercase tracking-wider rounded focus-ring"
          style={{ color: 'inherit', userSelect: 'none' }}
        >
          {children}
          {sorted && <span aria-hidden="true" style={{ fontSize: '10px' }}>{dir === 'asc' ? '↑' : '↓'}</span>}
        </button>
      ) : children}
      {resizable && table && (
        <ResizeHandle
          label={label}
          width={table.widths?.[ref.current?.cellIndex ?? -1]}
          measure={() => ref.current?.offsetWidth ?? MIN_COLUMN_WIDTH}
          onResize={(w) => {
            const cell = ref.current
            if (cell?.parentElement instanceof HTMLTableRowElement) table.resize(cell.parentElement, cell.cellIndex, w)
          }}
          onReset={table.reset}
        />
      )}
    </th>
  )
}
