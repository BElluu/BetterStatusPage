import { describe, expect, it } from 'vitest'
import { ALL_SECTIONS, ROLE_RANK, SHELL_CONFIG } from './Layout'

describe('admin shell configuration', () => {
  it('leads every page of the console below /admin and asks only for roles that exist', () => {
    for (const item of ALL_SECTIONS.flatMap((section) => section.items)) {
      expect(item.to.startsWith('/admin/')).toBe(true)
      expect(ROLE_RANK).toHaveProperty(item.minRole)
    }
  })

  it('groups the pages by purpose', () => {
    expect(ALL_SECTIONS.map((section) => section.label)).toEqual(['Monitoring', 'Alerts', 'Status page', 'Administration'])
  })

  it('links to the documentation and to the status page, and reads the notes of this release', () => {
    expect(SHELL_CONFIG.externalLinks.map((link) => link.label)).toEqual(['Status page', 'Documentation'])
    expect(SHELL_CONFIG.externalLinks[1]!.href()).toBe('https://docs.betterstatuspage.dev')
    expect(SHELL_CONFIG.whatsNew.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(SHELL_CONFIG.whatsNew.changelog).toContain('## [')
  })
})
