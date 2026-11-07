import { UsersPage, type SsoSectionEntry } from '@better-forge/ui'
import { AdminSignInSection } from '../components/AdminSignInSection'
import { StatusPageAccessModal } from '../components/StatusPageAccessModal'
import { StatusPageViewersSection } from '../components/StatusPageViewersSection'

const ROLES = [
  { value: 'admin',    label: 'Admin',    desc: 'Full access' },
  { value: 'operator', label: 'Operator', desc: 'Everything except Users' },
  { value: 'branding', label: 'Branding', desc: 'Branding & Builder' },
  { value: 'viewer',   label: 'Viewer',   desc: 'Views a private status page, no admin console' },
]

/** Higher number = more access; moving a user to a lower rank is a demotion and needs confirmation. */
const ROLE_RANK: Record<string, number> = { admin: 3, operator: 2, branding: 1, viewer: 0 }

const ACTIONS = [
  { label: 'Status page access', icon: 'lock', dialog: (close: () => void) => <StatusPageAccessModal onClose={close} /> },
]

/** The sections of the Single sign-on dialog, in the order of its icon strip; the first one opens first. */
const SSO_SECTIONS: readonly SsoSectionEntry[] = [
  { key: 'admin', label: 'Admin sign-in page', icon: 'admin_panel_settings', Component: AdminSignInSection },
  'options',
  { key: 'status', label: 'Private status page', icon: 'visibility_lock', Component: StatusPageViewersSection },
]

/** The users page with the roles of this product, who may view a private status page, and who gets an account on a first single sign-on. */
export default function Users() {
  return <UsersPage roles={ROLES} roleRank={ROLE_RANK} defaultRole="branding" actions={ACTIONS} ssoSections={SSO_SECTIONS} />
}
