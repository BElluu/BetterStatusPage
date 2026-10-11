import { describe, expect, it } from 'vitest'
import { compareVersions, parseChangelog, releasesBetween } from './changelog'

const SOURCE = `# Changelog

## [Unreleased]

### Added

- **Draft**: not shipped yet.

## [0.3.0] - 2026-11-01

### Added

- **Install script**: \`curl -fsSL https://x.dev/install.sh | sh\` downloads the file. It is safe to run again.
  - nested detail that is skipped.
- Plain entry without a title. Second sentence.

### Fixed

- **Link**: see [the docs](https://docs.example/x) for more. Extra.

## [0.2.1] - 2026-10-08

### Changed

- **Old**: thing.
`

describe('parseChangelog', () => {
  const releases = parseChangelog(SOURCE)

  it('skips Unreleased and keeps releases newest first', () => {
    expect(releases.map((r) => r.version)).toEqual(['0.3.0', '0.2.1'])
    expect(releases[0]!.date).toBe('2026-11-01')
  })

  it('cuts each bullet to its title and first sentence, as plain text', () => {
    expect(releases[0]!.groups).toEqual([
      { heading: 'Added', items: [
        { title: 'Install script', summary: 'curl -fsSL https://x.dev/install.sh | sh downloads the file.' },
        { title: '', summary: 'Plain entry without a title.' },
      ] },
      { heading: 'Fixed', items: [{ title: 'Link', summary: 'see the docs for more.' }] },
    ])
  })
})

describe('releasesBetween', () => {
  const releases = parseChangelog(SOURCE)

  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  it('returns releases after the seen one up to the current one', () => {
    expect(releasesBetween(releases, '0.2.1', '0.3.0').map((r) => r.version)).toEqual(['0.3.0'])
    expect(releasesBetween(releases, '0.3.0', '0.3.0')).toEqual([])
    expect(releasesBetween(releases, '0.0.1', '0.2.1').map((r) => r.version)).toEqual(['0.2.1'])
  })
})
