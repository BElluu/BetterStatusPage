import clsx from 'clsx'
import type { ReactNode } from 'react'

interface PageContainerProps {
  children: ReactNode
  className?: string | undefined
}

/** Standard page padding and vertical rhythm with the entrance animation every admin page uses. */
export function PageContainer({ children, className }: PageContainerProps) {
  return <div className={clsx('p-4 md:p-8 space-y-6 fade-up', className)}>{children}</div>
}

interface PageHeaderProps {
  title: ReactNode
  subtitle?: ReactNode | undefined
  /** Right-aligned controls (buttons, filters); they wrap under the title on narrow screens. */
  actions?: ReactNode | undefined
  /** Extra content rendered under the title row, e.g. tabs or a filter bar. */
  children?: ReactNode | undefined
}

export function PageHeader({ title, subtitle, actions, children }: PageHeaderProps) {
  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>{title}</h1>
          {subtitle && <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  )
}
