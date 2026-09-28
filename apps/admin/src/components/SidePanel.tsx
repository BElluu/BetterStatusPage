import type { ReactNode } from 'react'

export interface SidePanelMeta { icon: string; label: string }

/** The expandable column to the right of a modal form: a title bar and the open section. */
export function SidePanelFrame({ meta, children }: { meta: SidePanelMeta; children: ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: '360px', borderLeft: '1px solid var(--m3-outline-variant)', display: 'flex', flexDirection: 'column' }}>
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

/** The vertical icon strip that opens and closes side-panel sections. */
export function SideTabStrip<K extends string>({ tabs, meta, active, onToggle }: {
  tabs: SideTab<K>[]
  meta: Record<K, SidePanelMeta>
  active: K | null
  onToggle: (key: K | null) => void
}) {
  return (
    <div style={{ flex: '0 0 44px', borderLeft: '1px solid var(--m3-outline-variant)', display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
      {tabs.map((tab) => {
        const isActive = active === tab.key
        const current = meta[tab.key]
        return (
          <button key={tab.key} type="button"
            title={current.label}
            onClick={() => onToggle(isActive ? null : tab.key)}
            className={`relative flex flex-col items-center justify-center py-4 transition-all ${isActive ? 'monitor-side-tab-active' : ''}`}
            style={{ color: isActive ? 'var(--m3-primary)' : 'var(--m3-secondary)', background: isActive ? 'var(--m3-primary-fixed)' : 'transparent', borderBottom: '1px solid var(--m3-outline-variant)' }}
            onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-surface-container)' }}
            onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = '' }}
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
