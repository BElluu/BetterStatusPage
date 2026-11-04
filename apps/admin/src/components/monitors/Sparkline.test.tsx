import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sparkline } from './Sparkline'

const svg = () => screen.getByRole('img')

describe('Sparkline', () => {
  it('draws an area, a line and an end point for a run of values', () => {
    render(<Sparkline values={[10, 20, 15, 30]} status="up" label="Response time" />)
    expect(svg()).toHaveAccessibleName('Response time')
    expect(svg().querySelectorAll('path')).toHaveLength(2)
    expect(svg().querySelectorAll('circle')).toHaveLength(1)
  })

  it('breaks the line at a missing hour and draws a lone point as a dot', () => {
    const { container } = render(<Sparkline values={[10, 12, null, 20, null, 8, 9]} status="degraded" label="Gaps" />)
    // Two runs of two points have an area and a line each; the single point at index 3 is a dot, the last point a bigger one.
    expect(container.querySelectorAll('path')).toHaveLength(4)
    expect(container.querySelectorAll('circle')).toHaveLength(2)
  })

  it('draws nothing visible without two timed hours, and is hidden from assistive technology', () => {
    const { container } = render(<Sparkline values={[null, null, 5, null]} status="up" label="Too little" />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(container.querySelector('svg')).toBeNull()
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })

  it('colours the line by status', () => {
    render(<Sparkline values={[1, 2, 3]} status="down" label="Down" />)
    expect(svg().querySelectorAll('path')[1]).toHaveAttribute('stroke', 'var(--m3-down)')
  })
})
