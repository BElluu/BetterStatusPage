import { useId, type ReactNode } from 'react'

export interface QuickStartOption<K extends string> {
  key: K
  label: string
  hint: string
  /** Icon element (a Material Symbol or a brand glyph), rendered inside the tile's icon chip. */
  icon: ReactNode
}

interface QuickStartPanelProps<K extends string> {
  title: string
  description?: ReactNode | undefined
  options: QuickStartOption<K>[]
  onPick: (key: K) => void
}

/**
 * First-run panel shown in place of an empty list when the first step is a choice, e.g. which kind of
 * channel to create. Each tile starts the create flow with that choice already made.
 */
export function QuickStartPanel<K extends string>({ title, description, options, onPick }: QuickStartPanelProps<K>) {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className="rounded-2xl p-5 space-y-4"
      style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}
    >
      <div className="space-y-0.5">
        <h2 id={titleId} className="font-headline font-semibold text-[15px]" style={{ color: 'var(--m3-on-surface)' }}>{title}</h2>
        {description && <p className="text-[13px]" style={{ color: 'var(--m3-secondary)' }}>{description}</p>}
      </div>
      <ul className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
        {options.map((option) => (
          <li key={option.key}>
            <button
              type="button"
              onClick={() => onPick(option.key)}
              className="w-full h-full grid gap-2 content-start text-left rounded-[14px] p-3.5 border border-outline-variant bg-surface text-on-surface hover:border-outline hover:bg-surface-container-lowest motion-safe:transition-colors focus-ring"
            >
              <span
                className="grid place-items-center w-[34px] h-[34px] rounded-[10px]"
                aria-hidden="true"
                style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}
              >
                {option.icon}
              </span>
              <span className="text-[13px] font-semibold">{option.label}</span>
              <span className="text-xs" style={{ color: 'var(--m3-secondary)' }}>{option.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
