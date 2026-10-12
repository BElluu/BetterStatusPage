import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { CopyButton } from './CopyButton'
import { ModalFooter, ModalHeader, ModalShell } from './ModalShell'
import { ErrorState, LoadingState } from './ui'

type YamlKind = 'Monitor' | 'NotificationChannel' | 'Action'

interface YamlViewModalProps {
  kind: YamlKind
  /** The key of the monitor, channel or action. */
  objectKey: string
  /** What is shown, for the heading: "Public site". */
  title: string
  onClose: () => void
}

/** The file name offered for download: the key of the object. */
const fileName = (objectKey: string) => `${objectKey}.yaml`

/**
 * One monitor or channel as the YAML the Import page and the API read. It is a view, not an editor:
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
        className="rounded-2xl w-full max-w-3xl"
        style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}
      >
        <ModalHeader icon="data_object" titleId={titleId} title={<>YAML <span className="text-sm font-normal" style={{ color: 'var(--m3-secondary)' }}>{title}</span></>} onClose={onClose} />
        <div className="p-6 space-y-4">

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

        </div>

        <ModalFooter
          start={<>
            {data !== undefined && <CopyButton value={data} />}
            <button type="button" onClick={download} disabled={data === undefined} className="btn btn-secondary">
              <span className="material-symbols-outlined" aria-hidden="true">download</span>
              Download
            </button>
          </>}
        >
          <button type="button" onClick={onClose} className="btn btn-primary">Close</button>
        </ModalFooter>
      </div>
    </ModalShell>
  )
}
