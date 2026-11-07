import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AdminStatusPageAccess, StatusPageAccessSettings } from '@bsp/shared'
import { api } from '../api/client'
import { ModalFooter, ModalHeader, ModalShell } from '@better-forge/ui'
import { Alert, ErrorState, LoadingState, Switch, useToast } from '@better-forge/ui'

const QUERY_KEY = ['status-page-access']
const CARD = { background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)', color: 'var(--m3-on-surface)' }

/** Administrators decide whether the status page is public or needs a sign-in. Who gets a viewer account is set in Single sign-on. */
export function StatusPageAccessModal({ onClose }: { onClose: () => void }) {
  const { data, isError, refetch } = useQuery<AdminStatusPageAccess>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/admin/status-page-access'),
  })

  if (!data) {
    return <ModalShell align="top" onClose={onClose} label="Status page access">
      <div className="rounded-2xl p-6 w-full max-w-2xl" style={CARD}>
        {isError ? <ErrorState message="Could not load the access settings." onRetry={() => void refetch()} /> : <LoadingState label="Loading access settings…" />}
        {isError && <button type="button" className="btn btn-secondary mt-4" onClick={onClose}>Close</button>}
      </div>
    </ModalShell>
  }
  return <AccessForm settings={data} onClose={onClose} />
}

function AccessForm({ settings, onClose }: { settings: AdminStatusPageAccess; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [isPrivate, setPrivate] = useState(settings.private)
  const [error, setError] = useState('')

  const save = useMutation({
    mutationFn: (body: StatusPageAccessSettings) => api.put<AdminStatusPageAccess>('/admin/status-page-access', body),
    onSuccess: (saved) => {
      qc.setQueryData(QUERY_KEY, saved)
      // The subscription settings show which methods a private page switches off.
      void qc.invalidateQueries({ queryKey: ['subscription-settings'] })
      toast.success(saved.private ? 'The status page is now private.' : 'The status page is now public.')
      onClose()
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save the access settings'),
  })

  return <ModalShell align="top" onClose={save.isPending ? undefined : onClose} label="Status page access">
    <div className="w-full max-w-2xl rounded-2xl my-8" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)', color: 'var(--m3-on-surface)' }}>
      <ModalHeader icon="visibility_lock" title="Status page access" onClose={onClose} />
      <form
        onSubmit={(event) => {
          event.preventDefault()
          // Who gets a viewer account is set in Single sign-on; it is sent back as it is.
          save.mutate({ private: isPrivate, ssoCreateViewers: settings.ssoCreateViewers, ssoViewerDomains: settings.ssoViewerDomains })
        }}
      >
        <div className="p-6 space-y-5">
          {error && <Alert tone="error" onDismiss={() => setError('')}>{error}</Alert>}
          <p className="text-sm" style={{ color: 'var(--m3-secondary)' }}>
            Choose who can view the status page. A private page asks visitors to sign in with their password or single sign-on.
            Who gets a viewer account on a first single sign-on is set in <strong>Single sign-on</strong>.
          </p>

          <fieldset disabled={save.isPending}>
            <Switch
              checked={isPrivate}
              onChange={setPrivate}
              label="Private status page"
              description="Only signed-in users can view the page. Every user can sign in; give people who should only view the page the Viewer role. RSS and Atom feeds, the Slack feed and the status API are switched off, because nothing outside the page can sign in to them."
            />
          </fieldset>
        </div>

        <ModalFooter>
          <button type="button" disabled={save.isPending} onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={save.isPending} className="btn btn-primary">{save.isPending ? 'Saving…' : 'Save'}</button>
        </ModalFooter>
      </form>
    </div>
  </ModalShell>
}
