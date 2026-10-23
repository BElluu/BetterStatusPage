import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useLocale } from '../i18n/LocaleContext'

function ErrorScreen() {
  const { t } = useLocale()
  return (
    <div role="alert" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center', background: 'var(--m3-surface)', color: 'var(--m3-on-surface)' }}>
      <h1 style={{ fontSize: 18, fontWeight: 700 }}>{t('page.error')}</h1>
      <p style={{ fontSize: 14, maxWidth: 420, color: 'var(--m3-secondary)' }}>{t('page.errorHint')}</p>
      <button type="button" onClick={() => window.location.reload()} style={{ padding: '8px 16px', borderRadius: 12, border: '1px solid var(--m3-outline-variant)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
        {t('page.reload')}
      </button>
    </div>
  )
}

/** Keeps a render error or a failed lazy import from leaving the public page blank; offers a reload. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(error, info.componentStack)
  }

  override render(): ReactNode {
    return this.state.failed ? <ErrorScreen /> : this.props.children
  }
}
