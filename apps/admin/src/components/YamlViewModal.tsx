import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { CopyButton } from './CopyButton'
import { ModalShell } from './ModalShell'
import { ErrorState, LoadingState } from './ui'

export type YamlKind = 'Monitor' | 'NotificationChannel'

interface YamlViewModalProps {
  kind: YamlKind
  /** The key of the monitor or channel. */
  objectKey: string
  /** What is shown, for the heading: "Public site". */
  title: string
  onClose: () => void
}

/** The file name offered for download: the key, or the kind for the layout. */
const fileName = (objectKey: string) => `${objectKey}.yaml`

/**
 * One monitor, channel or the layout as the YAML the Import page and the API read. It is a view, not an editor:
 * passwords and tokens are written as ••••••••, so a copy of it is safe to keep in version control.
 */
export function YamlViewModal({ kind, objectKey, title, onClose }: YamlViewModalProps) {
  const titleId = useId()
  const query = new URLSearchParams({ kind, key: objectKey }).toString()
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['config-yaml', kind, objectKey],
    queryFn: () => api.getText(`/admin/config/export?${query}`),
    // The view must show what is stored now, not what was stored when it was last opened.
    gcTime: 0,
    retry: false,
  })

  function download() {
    if (data === undefined) return
    const url = URL.createObjectURL(new Blob([data], { type: 'application/yaml' }))
    const link = document.createElement('a')
    link.href = url
    link.download = fileName(objectKey)
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <ModalShell onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="rounded-2xl p-6 w-full max-w-3xl space-y-4"
        style={{ background: 'var(--m3-surface-container-lowest)', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 id={titleId} className="font-headline text-lg font-bold" style={{ color: 'var(--m3-on-surface)' }}>YAML</h3>
            <p className="text-sm truncate" style={{ color: 'var(--m3-secondary)' }}>{title}</p>
          </div>
        </div>

        <p className="text-sm" style={{ color: 'var(--m3-secondary)' }}>
          Passwords, tokens and webhook URLs are written as <code className="font-mono">••••••••</code>. Paste this on the Import page of another
          installation, or send it to the API, to create or update this {kind === 'Monitor' ? 'monitor' : 'notification channel'} there.
        </p>

        {isLoading ? (
          <LoadingState label="Loading YAML…" />
        ) : isError ? (
          <ErrorState message={error instanceof Error ? error.message : 'Could not load the YAML.'} onRetry={() => void refetch()} />
        ) : (
          <pre
            tabIndex={0}
            aria-label="YAML"
            className="font-mono text-xs rounded-xl p-4 overflow-auto max-h-[50vh] whitespace-pre"
            style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-on-surface)' }}
          >
            {data}
          </pre>
        )}

        <div className="flex flex-wrap items-center justify-end gap-3">
          {data !== undefined && <CopyButton value={data} />}
          <button type="button" onClick={download} disabled={data === undefined} className="btn btn-secondary">
            <span className="material-symbols-outlined" aria-hidden="true">download</span>
            Download
          </button>
          <button type="button" onClick={onClose} className="btn btn-primary">Close</button>
        </div>
      </div>
    </ModalShell>
  )
}
