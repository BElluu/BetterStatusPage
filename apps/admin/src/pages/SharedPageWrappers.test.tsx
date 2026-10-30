import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AuditEntities } from '@better-forge/ui'
import type { TokenPreset, TokenResource } from '@better-forge/contracts'
import AuditLog, { ENTITY_TYPES_ALL_GROUPED } from './AuditLog'
import ApiTokens from './ApiTokens'
import Login from './Login'
import Users from './Users'

// The shared pages are tested in the interface package; here only what this product hands them is checked.
vi.mock('@better-forge/ui', () => ({
  ApiTokensPage: ({ resources, presets, actions }: { resources: TokenResource[]; presets: TokenPreset[]; actions: ReactNode }) => (
    <div><p data-testid="tokens">{resources.map((resource) => resource.key).join(',')}|{presets.map((preset) => preset.label).join(',')}</p>{actions}</div>
  ),
  LoginPage: ({ headline, tagline, features }: { headline: ReactNode; tagline: string; features: Array<{ label: string }> }) => (
    <div data-testid="login"><h2>{headline}</h2><p>{tagline}</p><p>{features.map((feature) => feature.label).join('|')}</p></div>
  ),
  UsersPage: ({ roles, roleRank, defaultRole, actions }: { roles: Array<{ value: string }>; roleRank: Record<string, number>; defaultRole: string; actions: Array<{ label: string; dialog: (close: () => void) => unknown }> }) => (
    <p data-testid="users">{roles.map((role) => role.value).join(',')}|{Object.keys(roleRank).join(',')}|{defaultRole}|{actions.map((action) => action.label).join(',')}</p>
  ),
  AuditLogPage: ({ entities }: { entities: AuditEntities }) => (
    <p data-testid="audit">{entities.groups.map((group) => group.label).join(',')}|{entities.labels['monitor']}|{entities.icons['monitor']}</p>
  ),
}))

vi.mock('../components/McpSettingsModal', () => ({
  McpSettingsModal: ({ onClose }: { onClose: () => void }) => <div role="dialog" aria-label="MCP for AI agents"><button type="button" onClick={onClose}>Close</button></div>,
}))

describe('shared pages as this product configures them', () => {
  it('gives the API tokens page the permissions of this API and its presets', () => {
    render(<ApiTokens />)
    const text = screen.getByTestId('tokens').textContent!
    expect(text).toContain('monitors,channels,actions,incidents')
    expect(text).toContain('Report incidents,Deploy monitoring,Read only')
  })

  it('puts an MCP button next to New token that opens its own dialog', async () => {
    const user = userEvent.setup()
    render(<ApiTokens />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'MCP' }))
    expect(screen.getByRole('dialog', { name: 'MCP for AI agents' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('tells the sign-in page what this product is', () => {
    render(<Login />)
    const login = screen.getByTestId('login')
    expect(login).toHaveTextContent('Monitor everything.Stay ahead of issues.')
    expect(login).toHaveTextContent('uptime monitoring')
    expect(login).toHaveTextContent('Live status updates|Incidents and maintenance notices|Alerts through your notification channels')
  })

  it('gives the users page the roles of this product and the status page access setting', () => {
    render(<Users />)
    expect(screen.getByTestId('users').textContent).toBe('admin,operator,branding,viewer|admin,operator,branding,viewer|branding|Status page access')
  })

  it('gives the audit log every thing this product records, in sections', () => {
    render(<AuditLog />)
    expect(screen.getByTestId('audit').textContent).toBe('Monitoring,Notifications,Access & security,Appearance,System|Monitor|radio_button_checked')
    expect(ENTITY_TYPES_ALL_GROUPED).toBe(true)
  })
})
