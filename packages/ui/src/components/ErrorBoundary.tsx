import { Component, type ErrorInfo, type ReactNode } from 'react'

/** A lazy chunk that failed to load: after a deploy the old file names are gone, so the page needs a reload. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(message)
}

interface Props {
  children: ReactNode
}

interface State {
  error: unknown
}

/** Catches errors thrown while rendering (and by lazy imports) so the screen is not left blank; offers a reload. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error ?? new Error('Unknown error') }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const stale = isChunkLoadError(error)
    return (
      <div role="alert" className="min-h-screen flex flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: 'var(--m3-surface)', color: 'var(--m3-on-surface)' }}>
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '32px', color: 'var(--m3-down)' }}>error</span>
        <h1 className="font-headline text-lg font-bold">{stale ? 'A new version is available' : 'Something went wrong'}</h1>
        <p className="text-sm max-w-md" style={{ color: 'var(--m3-secondary)' }}>
          {stale ? 'This page was updated while it was open. Reload to continue.' : 'The page could not be displayed. Reloading usually fixes it.'}
        </p>
        <button type="button" onClick={() => window.location.reload()} className="btn btn-secondary btn-sm">
          <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
          Reload
        </button>
      </div>
    )
  }
}
