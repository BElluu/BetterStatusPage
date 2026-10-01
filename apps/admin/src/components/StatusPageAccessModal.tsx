import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AdminStatusPageAccess, StatusPageAccessSettings } from '@bsp/shared'
import { api } from '../api/client'
import { ModalShell } from './ModalShell'
import { Alert, ErrorState, LoadingState, Switch, useToast } from './ui'

const QUERY_KEY = ['status-page-access']
const CARD = { background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)', color: 'var(--m3-on-surface)' }

function parseDomains(value: string): string[] {
  return value.split(/[\s,;]+/).map((domain) => domain.trim()).filter(Boolean)
}

/** Administrators decide whether the status page is public or needs a sign-in. */
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
  const ids = useId()
  const [isPrivate, setPrivate] = useState(settings.private)
  const [createViewers, setCreateViewers] = useState(settings.ssoCreateViewers)
  const [domains, setDomains] = useState(settings.ssoViewerDomains.join(', '))
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
    <div className="w-full max-w-2xl space-y-3">
      {error && <Alert tone="error" onDismiss={() => setError('')}>{error}</Alert>}
      <form
        className="rounded-2xl p-6 space-y-5 w-full"
        style={CARD}
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate({ private: isPrivate, ssoCreateViewers: createViewers, ssoViewerDomains: parseDomains(domains) })
        }}
      >
        <div>
          <h2 className="font-headline text-xl font-semibold">Status page access</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>
            Choose who can view the status page. A private page asks visitors to sign in with their password or single sign-on.
          </p>
        </div>

        <fieldset disabled={save.isPending} className="space-y-5">
          <Switch
            checked={isPrivate}
            onChange={setPrivate}
            label="Private status page"
            description="Only signed-in users can view the page. Every user can sign in; give people who should only view the page the Viewer role. RSS and Atom feeds, the Slack feed and the status API are switched off, because nothing outside the page can sign in to them."
          />

          {isPrivate && (
            <div className="space-y-4 rounded-xl p-4" style={{ background: 'var(--m3-surface-container)' }}>
              <Switch
                checked={createViewers}
                onChange={setCreateViewers}
                disabled={!settings.ssoConfigured && !createViewers}
                label="Create viewer accounts on single sign-on"
                description={settings.ssoConfigured
                  ? 'Someone without an account who signs in through SSO with a verified email from one of the domains below gets a Viewer account.'
                  : 'Set up single sign-on first.'}
              />
              {createViewers && (
                <div>
                  <label htmlFor={`${ids}-domains`} className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Email domains</label>
                  <input
                    id={`${ids}-domains`}
                    type="text"
                    value={domains}
                    onChange={(event) => setDomains(event.target.value)}
                    aria-describedby={`${ids}-domains-hint`}
                    className="input-m3"
                    placeholder="example.com, example.org"
                  />
                  <p id={`${ids}-domains-hint`} className="text-xs mt-1.5" style={{ color: 'var(--m3-secondary)' }}>
                    Separate domains with commas. At least one is required, so accounts at a shared provider such as Google cannot sign up.
                  </p>
                </div>
              )}
            </div>
          )}
        </fieldset>

        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={save.isPending} className="btn btn-primary">{save.isPending ? 'Saving…' : 'Save'}</button>
          <button type="button" disabled={save.isPending} onClick={onClose} className="btn btn-secondary ml-auto">Close</button>
        </div>
      </form>
    </div>
  </ModalShell>
}
