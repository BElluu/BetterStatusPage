import { UsersPage } from '@better-kit/ui'
import { StatusPageAccessModal } from '../components/StatusPageAccessModal'

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

/** The users page with the roles of this product and the setting of who may view a private status page. */
export default function Users() {
  return <UsersPage roles={ROLES} roleRank={ROLE_RANK} defaultRole="branding" actions={ACTIONS} />
}
