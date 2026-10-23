import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import { AutoIncidentSection, type AutoIncidentValues } from './AutoIncidentSection'

vi.mock('../../api/client', () => ({ api: { get: vi.fn() } }))

const disabled: AutoIncidentValues = { autoIncidentMinutes: null, autoIncidentMode: 'draft', autoIncidentTemplateId: null }
const enabled: AutoIncidentValues = { autoIncidentMinutes: 10, autoIncidentMode: 'draft', autoIncidentTemplateId: null }

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue([
    { id: 1, name: 'Default', isDefault: true },
    { id: 2, name: 'Custom', isDefault: false },
  ])
})

describe('AutoIncidentSection', () => {
  it('hides the settings while disabled and enables with the default delay', async () => {
    const onChange = vi.fn()
    render(<AutoIncidentSection values={disabled} onChange={onChange} />)
    expect(screen.queryByText('Down for (minutes)')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledWith({ autoIncidentMinutes: 5 })
    await waitFor(() => expect(api.get).toHaveBeenCalled())
  })

  it('disables by clearing the delay', async () => {
    const onChange = vi.fn()
    render(<AutoIncidentSection values={enabled} onChange={onChange} />)
    await userEvent.setup().click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledWith({ autoIncidentMinutes: null })
  })

  it('clamps the delay, changes the mode and picks a non-default template', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<AutoIncidentSection values={enabled} onChange={onChange} />)
    await screen.findByRole('option', { name: 'Custom' })
    expect(screen.queryByRole('option', { name: 'Default' })).not.toBeInTheDocument()

    const [minutes] = screen.getAllByRole('spinbutton')
    await user.clear(minutes!)
    expect(onChange).toHaveBeenLastCalledWith({ autoIncidentMinutes: 1 })
    fireEvent.change(minutes!, { target: { value: '99999' } })
    expect(onChange).toHaveBeenLastCalledWith({ autoIncidentMinutes: 10080 })

    const [mode, template] = screen.getAllByRole('combobox')
    await user.selectOptions(mode!, 'published')
    expect(onChange).toHaveBeenLastCalledWith({ autoIncidentMode: 'published' })
    await user.selectOptions(template!, 'Custom')
    expect(onChange).toHaveBeenLastCalledWith({ autoIncidentTemplateId: 2 })
    await user.selectOptions(template!, 'Default template')
    expect(onChange).toHaveBeenLastCalledWith({ autoIncidentTemplateId: null })
  })

  it('still renders when the templates cannot be loaded', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('offline'))
    render(<AutoIncidentSection values={enabled} onChange={vi.fn()} />)
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(screen.getByRole('option', { name: 'Default template' })).toBeInTheDocument()
  })
})
