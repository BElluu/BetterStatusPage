import { useEffect, useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SSO_GROUP_ROLES, type AdminSsoProvisioning, type SsoGroupRole, type SsoProvisioningSettings } from '@bsp/shared'
import { api } from '../api/client'
import { ErrorState, LoadingState, Note, Switch, type SsoSectionProps } from '@better-forge/ui'

const QUERY_KEY = ['sso-provisioning']
const LABEL = 'block font-mono text-xs uppercase tracking-wider mb-2'
const HINT = { color: 'var(--m3-secondary)' }
const ROLE_LABEL: Record<string, string> = { admin: 'Admin', operator: 'Operator', branding: 'Branding', viewer: 'Viewer' }

export function parseDomains(value: string): string[] {
  return value.split(/[\s,;]+/).map((domain) => domain.trim().toLowerCase()).filter(Boolean)
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const stored = (s: AdminSsoProvisioning): SsoProvisioningSettings => ({ enabled: s.enabled, allowedDomains: s.allowedDomains, groupsClaim: s.groupsClaim, groupRoles: s.groupRoles })

/**
 * A section of the Single sign-on dialog, saved with it: who gets an account on a first sign-in from the admin sign-in
 * page, and with which role (the role of the person's group at the identity provider).
 */
export function AdminSignInSection({ onChange }: SsoSectionProps) {
  const { data, isError, refetch } = useQuery<AdminSsoProvisioning>({ queryKey: QUERY_KEY, queryFn: () => api.get('/admin/sso-provisioning') })
  if (data) return <Form settings={data} onChange={onChange} />
  return isError
    ? <ErrorState message="Could not load the account settings." onRetry={() => void refetch()} />
    : <LoadingState label="Loading account settings…" />
}

function Form({ settings, onChange }: { settings: AdminSsoProvisioning; onChange: SsoSectionProps['onChange'] }) {
  const qc = useQueryClient()
  const ids = useId()
  const [enabled, setEnabled] = useState(settings.enabled)
  const [domains, setDomains] = useState(settings.allowedDomains.join(', '))
  const [claim, setClaim] = useState(settings.groupsClaim)
  const [rows, setRows] = useState<SsoGroupRole[]>(settings.groupRoles.length ? settings.groupRoles : [{ group: '', role: 'viewer' }])

  const draft: SsoProvisioningSettings = {
    enabled,
    allowedDomains: parseDomains(domains),
    groupsClaim: claim.trim(),
    groupRoles: rows.filter((row) => row.group.trim()).map((row) => ({ group: row.group.trim(), role: row.role })),
  }
  const changed = !same(draft, stored(settings))

  useEffect(() => {
    const badge = draft.enabled && draft.groupRoles.length > 0 ? String(draft.groupRoles.length) : null
    if (!changed) return onChange(null, badge)
    // The same refusals as the API, so nothing is saved when this part would be refused.
    const problem = draft.enabled && draft.allowedDomains.length === 0 ? 'Add at least one email domain to create accounts on SSO sign-in'
      : draft.enabled && draft.groupRoles.length === 0 ? 'Map at least one group to a role to create accounts on SSO sign-in'
      : undefined
    onChange({
      problem,
      async save(currentPassword) {
        const saved = await api.put<AdminSsoProvisioning>('/admin/sso-provisioning', { ...draft, ...(currentPassword === undefined ? {} : { currentPassword }) })
        qc.setQueryData(QUERY_KEY, saved)
      },
    }, badge)
  })

  const setRow = (index: number, change: Partial<SsoGroupRole>) => setRows((current) => current.map((row, i) => (i === index ? { ...row, ...change } : row)))
  const mapsAdmin = enabled && rows.some((row) => row.role === 'admin' && row.group.trim())

  return <div className="space-y-4">
    <Switch
      checked={enabled}
      onChange={setEnabled}
      label="Create accounts on sign-in"
      description="Someone without an account who signs in from the admin sign-in page gets one, with the role of their group at the identity provider. Without it, only people who already have an account can sign in."
    />
    {enabled && <>
      <div>
        <label htmlFor={`${ids}-domains`} className={LABEL} style={HINT}>Email domains</label>
        <input id={`${ids}-domains`} type="text" value={domains} onChange={(event) => setDomains(event.target.value)}
          aria-describedby={`${ids}-domains-hint`} className="input-m3" placeholder="example.com, example.org" />
        <p id={`${ids}-domains-hint`} className="text-xs mt-1.5" style={HINT}>
          Only these domains can sign up. At least one is required, so accounts at a shared provider such as Google cannot.
        </p>
      </div>

      <div>
        <label htmlFor={`${ids}-claim`} className={LABEL} style={HINT}>Groups claim</label>
        <input id={`${ids}-claim`} type="text" value={claim} onChange={(event) => setClaim(event.target.value)} className="input-m3" placeholder="groups" />
        <p className="text-xs mt-1.5" style={HINT}>
          The ID token claim that lists the person&apos;s groups. Run <strong>Test sign-in</strong> to see the claims your provider sends.
        </p>
      </div>

      <div>
        <span className={LABEL} style={HINT}>Group to role</span>
        <div className="space-y-2">
          {rows.map((row, index) => (
            <div key={index} className="flex gap-2 items-center">
              <input type="text" aria-label={`Group ${index + 1}`} value={row.group} onChange={(event) => setRow(index, { group: event.target.value })}
                className="input-m3 flex-1 min-w-0" placeholder="Group name, as the provider sends it" />
              <select aria-label={`Role of group ${index + 1}`} value={row.role} onChange={(event) => setRow(index, { role: event.target.value as SsoGroupRole['role'] })} className="input-sig" style={{ width: "7rem", flex: "none" }}>
                {SSO_GROUP_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABEL[role]}</option>)}
              </select>
              <button type="button" className="btn btn-secondary shrink-0" aria-label={`Remove group ${index + 1}`}
                onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>
                <span className="material-symbols-outlined" aria-hidden="true">close</span>
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-secondary mt-2" onClick={() => setRows((current) => [...current, { group: '', role: 'viewer' }])}>Add group</button>
        <p className="text-xs mt-1.5" style={HINT}>
          Type each group exactly as <strong>Test sign-in</strong> shows it, with the same capitals. Microsoft Entra ID sends the object ID of a group (a GUID), not its name, and Keycloak a path such as /Technicians.
          A person in several of these groups gets the highest role. Someone in none of them gets no account. The role is set when the account is
          created; later changes of groups at the provider do not change it, change the role in Users.
        </p>
      </div>
      {mapsAdmin && <Note tone="warning">A group is mapped to Admin: everyone in it from the listed domains gets full access on their first sign-in.</Note>}
    </>}
    {(enabled) && <p className="text-xs" style={HINT}>Giving more access than before asks for your password (or a sign-in at the identity provider) when you save.</p>}
  </div>
}
