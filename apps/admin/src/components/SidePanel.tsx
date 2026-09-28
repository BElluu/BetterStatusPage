import clsx from 'clsx'
import type { ReactNode } from 'react'

export interface SidePanelMeta { icon: string; label: string }

/**
 * `row`: the panel always sits to the right of the form (legacy layout).
 * `responsive`: below the lg breakpoint the panel spans the full width under the form with a top border;
 * from lg up it becomes the right-hand column. The parent must switch to `flex-col lg:flex-row` to match.
 */
export type SidePanelLayout = 'row' | 'responsive'

/** The expandable column to the right of a modal form: a title bar and the open section. */
export function SidePanelFrame({ meta, children, layout = 'row', className }: {
  meta: SidePanelMeta
  children: ReactNode
  layout?: SidePanelLayout | undefined
  className?: string | undefined
}) {
  return (
    <div
      data-testid="side-panel-frame"
      className={clsx(
        'flex flex-col flex-1 min-w-0 border-outline-variant',
        layout === 'row' ? 'border-l lg:min-w-[360px]' : 'w-full border-t lg:w-auto lg:border-t-0 lg:border-l lg:min-w-[360px]',
        className,
      )}
    >
      {/* Panel header — just the section title */}
      <div className="flex items-center gap-2 px-5 py-4" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
        <span className="material-symbols-outlined" style={{ fontSize: '16px', color: 'var(--m3-primary)' }}>{meta.icon}</span>
        <span className="font-mono text-xs uppercase tracking-wider font-medium" style={{ color: 'var(--m3-on-surface)', flex: 1 }}>{meta.label}</span>
      </div>

      {/* Tab content */}
      <div className="p-5 space-y-4 overflow-y-auto" style={{ flex: 1 }}>
        {children}
      </div>
    </div>
  )
}

export interface SideTab<K extends string> { key: K; badge: string | null }

/**
 * The icon strip that opens and closes side-panel sections: vertical at the form's right edge, or with
 * `layout="responsive"` a horizontal row below lg and the vertical strip from lg up.
 */
export function SideTabStrip<K extends string>({ tabs, meta, active, onToggle, layout = 'row', className }: {
  tabs: SideTab<K>[]
  meta: Record<K, SidePanelMeta>
  active: K | null
  onToggle: (key: K | null) => void
  layout?: SidePanelLayout | undefined
  className?: string | undefined
}) {
  const responsive = layout === 'responsive'
  return (
    <div
      role="toolbar"
      aria-orientation={responsive ? undefined : 'vertical'}
      className={clsx(
        'flex items-stretch border-outline-variant',
        responsive ? 'flex-row w-full border-t lg:w-11 lg:flex-none lg:flex-col lg:border-t-0 lg:border-l' : 'flex-col flex-none w-11 border-l',
        className,
      )}
    >
      {tabs.map((tab) => {
        const isActive = active === tab.key
        const current = meta[tab.key]
        return (
          <button key={tab.key} type="button"
            aria-pressed={isActive}
            aria-label={current.label}
            title={current.label}
            onClick={() => onToggle(isActive ? null : tab.key)}
            className={clsx(
              'relative flex flex-col items-center justify-center transition-all border-outline-variant focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-outline',
              responsive ? 'flex-1 py-3 border-r last:border-r-0 lg:flex-none lg:py-4 lg:border-r-0 lg:border-b' : 'py-4 border-b',
              isActive ? 'monitor-side-tab-active' : 'hover:bg-surface-container',
            )}
            style={{ color: isActive ? 'var(--m3-primary)' : 'var(--m3-secondary)', background: isActive ? 'var(--m3-primary-fixed)' : undefined }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>{current.icon}</span>
            {tab.badge && (
              <span className={`absolute top-1.5 right-1 flex items-center justify-center rounded-full font-bold leading-none ${isActive ? 'monitor-side-tab-badge-active' : ''}`}
                style={{ background: isActive ? 'var(--m3-primary)' : 'var(--m3-on-surface-variant)', color: isActive ? 'var(--m3-on-primary)' : 'var(--m3-surface)', minWidth: '14px', height: '14px', fontSize: '9px', padding: '0 2px' }}>
                {tab.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
