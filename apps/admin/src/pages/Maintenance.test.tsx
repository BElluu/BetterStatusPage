import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DateTimeInput } from './Maintenance'

describe('maintenance date and time input', () => {
  it('updates the date, hour, and minute without changing the local datetime format', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <DateTimeInput label="Starts At" value="2026-07-15T09:05" onChange={onChange} />,
    )

    fireEvent.change(screen.getByLabelText('Starts At — YYYY-MM-DD'), {
      target: { value: '2026-07-20' },
    })
    expect(onChange).toHaveBeenLastCalledWith('2026-07-20T09:05')

    rerender(<DateTimeInput label="Starts At" value="2026-07-20T09:05" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Starts At — HH'), { target: { value: '17' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-07-20T17:05')

    rerender(<DateTimeInput label="Starts At" value="2026-07-20T17:05" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Starts At — MM'), { target: { value: '42' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-07-20T17:42')
  })
})
