import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { highlightYaml } from './YamlEditor'

const DOCUMENT = `# a comment
---
kind: Monitor
key: "public-site"
intervalSecs: 30  # seconds
tags:
  - prod
  - label: x
password: ••••••••`

describe('highlightYaml', () => {
  it('keeps the text exactly, so it can sit under a textarea', () => {
    const { container } = render(<pre>{highlightYaml(DOCUMENT)}</pre>)
    expect(container.textContent).toBe(DOCUMENT)
  })

  it('colours keys, strings, literals and comments', () => {
    const { container } = render(<pre>{highlightYaml(DOCUMENT)}</pre>)
    const colored = (text: string) => [...container.querySelectorAll('span')].find((each) => each.textContent === text)?.style.color
    expect(colored('kind')).toBe('var(--m3-primary)')
    expect(colored('"public-site"')).toBe('var(--m3-up)')
    expect(colored('30')).toBe('var(--m3-degraded)')
    expect(colored('# seconds')).toBe('var(--m3-secondary)')
    expect(colored('# a comment')).toBe('var(--m3-secondary)')
    expect(colored('label')).toBe('var(--m3-primary)')
  })
})
