import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AuditEntities } from '@better-kit/ui'
import type { TokenPreset, TokenResource } from '@better-kit/contracts'
import AuditLog, { ENTITY_TYPES_ALL_GROUPED } from './AuditLog'
import ApiTokens from './ApiTokens'
import Users from './Users'

// The shared pages are tested in the interface package; here only what this product hands them is checked.
vi.mock('@better-kit/ui', () => ({
  ApiTokensPage: ({ resources, presets }: { resources: TokenResource[]; presets: TokenPreset[] }) => (
    <p data-testid="tokens">{resources.map((resource) => resource.key).join(',')}|{presets.map((preset) => preset.label).join(',')}</p>
  ),
  UsersPage: ({ roles, roleRank, defaultRole, actions }: { roles: Array<{ value: string }>; roleRank: Record<string, number>; defaultRole: string; actions: Array<{ label: string; dialog: (close: () => void) => unknown }> }) => (
    <p data-testid="users">{roles.map((role) => role.value).join(',')}|{Object.keys(roleRank).join(',')}|{defaultRole}|{actions.map((action) => action.label).join(',')}</p>
  ),
  AuditLogPage: ({ entities }: { entities: AuditEntities }) => (
    <p data-testid="audit">{entities.groups.map((group) => group.label).join(',')}|{entities.labels['monitor']}|{entities.icons['monitor']}</p>
  ),
}))

describe('shared pages as this product configures them', () => {
  it('gives the API tokens page the permissions of this API and its presets', () => {
    render(<ApiTokens />)
    const text = screen.getByTestId('tokens').textContent!
    expect(text).toContain('monitors,channels,actions,incidents')
    expect(text).toContain('Report incidents,Deploy monitoring,Read only')
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
