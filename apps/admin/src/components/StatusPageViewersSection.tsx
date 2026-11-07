import { useEffect, useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AdminStatusPageAccess, StatusPageAccessSettings } from '@bsp/shared'
import { api } from '../api/client'
import { ErrorState, LoadingState, Switch, type SsoSectionProps } from '@better-forge/ui'
import { parseDomains } from './AdminSignInSection'

const QUERY_KEY = ['status-page-access']
const HINT = { color: 'var(--m3-secondary)' }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * A section of the Single sign-on dialog, saved with it: whether a first sign-in from a private status page creates a
 * Viewer account, and for which email domains. Whether the page is private is set in Status page access.
 */
export function StatusPageViewersSection({ onChange }: SsoSectionProps) {
  const { data, isError, refetch } = useQuery<AdminStatusPageAccess>({ queryKey: QUERY_KEY, queryFn: () => api.get('/admin/status-page-access') })
  if (data) return <Form settings={data} onChange={onChange} />
  return isError
    ? <ErrorState message="Could not load the access settings." onRetry={() => void refetch()} />
    : <LoadingState label="Loading access settings…" />
}

function Form({ settings, onChange }: { settings: AdminStatusPageAccess; onChange: SsoSectionProps['onChange'] }) {
  const qc = useQueryClient()
  const ids = useId()
  const [createViewers, setCreateViewers] = useState(settings.ssoCreateViewers)
  const [domains, setDomains] = useState(settings.ssoViewerDomains.join(', '))

  const draft = { ssoCreateViewers: createViewers, ssoViewerDomains: parseDomains(domains) }
  const changed = !same(draft, { ssoCreateViewers: settings.ssoCreateViewers, ssoViewerDomains: settings.ssoViewerDomains })

  useEffect(() => {
    const badge = draft.ssoCreateViewers && draft.ssoViewerDomains.length > 0 ? String(draft.ssoViewerDomains.length) : null
    if (!changed) return onChange(null, badge)
    onChange({
      problem: draft.ssoCreateViewers && draft.ssoViewerDomains.length === 0 ? 'Add at least one email domain to create viewer accounts on SSO sign-in' : undefined,
      async save() {
        // Whether the page is private is not changed here: it is sent back as it is.
        const body: StatusPageAccessSettings = { private: settings.private, ...draft }
        qc.setQueryData(QUERY_KEY, await api.put<AdminStatusPageAccess>('/admin/status-page-access', body))
      },
    }, badge)
  })

  return <div className="space-y-4">
    <Switch
      checked={createViewers}
      onChange={setCreateViewers}
      label="Create viewer accounts on sign-in"
      description={`Someone without an account who signs in from a private status page with a verified email from one of the domains below gets a Viewer account.${settings.private ? '' : ' The status page is public now, so this applies once it is private (Status page access).'}`}
    />
    {createViewers && (
      <div>
        <label htmlFor={`${ids}-domains`} className="block font-mono text-xs uppercase tracking-wider mb-2" style={HINT}>Email domains</label>
        <input
          id={`${ids}-domains`}
          type="text"
          value={domains}
          onChange={(event) => setDomains(event.target.value)}
          aria-describedby={`${ids}-domains-hint`}
          className="input-m3"
          placeholder="example.com, example.org"
        />
        <p id={`${ids}-domains-hint`} className="text-xs mt-1.5" style={HINT}>
          Separate domains with commas. At least one is required, so accounts at a shared provider such as Google cannot sign up.
        </p>
      </div>
    )}
  </div>
}
