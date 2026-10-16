import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ReleaseNotes } from '../lib/changelog'
import { WhatsNew } from './WhatsNew'

const item = (title: string) => ({ title, summary: `${title} summary.` })

function release(groups: Record<string, string[]>): ReleaseNotes {
  return { version: '0.3.0', date: '2026-11-01', groups: Object.entries(groups).map(([heading, titles]) => ({ heading, items: titles.map(item) })) }
}

function sectionOf(name: RegExp) {
  return screen.getByText(name).closest('details')!
}

describe('WhatsNew', () => {
  it('opens the first section and leaves empty ones out', () => {
    render(<WhatsNew docsUrl="https://docs.test" releases={[release({ Added: ['Alpha'], Fixed: ['Beta'] })]} onClose={() => {}} />)
    expect(sectionOf(/^New/)).toHaveAttribute('open')
    expect(sectionOf(/^Fixes/)).not.toHaveAttribute('open')
    expect(screen.queryByText(/^Changed/)).not.toBeInTheDocument()
  })

  it('opens the first section that has entries when there is nothing new', () => {
    render(<WhatsNew docsUrl="https://docs.test" releases={[release({ Fixed: ['Beta'] })]} onClose={() => {}} />)
    expect(screen.queryByText(/^New/)).not.toBeInTheDocument()
    expect(sectionOf(/^Fixes/)).toHaveAttribute('open')
  })
})
