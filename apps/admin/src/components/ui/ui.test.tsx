import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Alert, EmptyState, EmptyStateLink, EmptyTableRow, ErrorState, Field, LoadingState, PageContainer, PageHeader, Pagination, QuickStartPanel, Switch, ToastProvider, useToast } from '.'

describe('PageHeader', () => {
  it('renders the title, subtitle, actions and extra content inside a padded container', () => {
    const { container } = render(
      <PageContainer className="extra">
        <PageHeader title="Monitors" subtitle="3 monitors" actions={<button type="button">Add</button>}>
          <p>Filters</p>
        </PageHeader>
      </PageContainer>,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Monitors' })).toHaveClass('font-headline', 'font-bold', 'text-2xl')
    expect(screen.getByText('3 monitors')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
    expect(screen.getByText('Filters')).toBeInTheDocument()
    expect(container.firstChild).toHaveClass('p-4', 'md:p-8', 'extra')
  })
})

describe('Alert', () => {
  it('announces errors assertively and other tones politely', () => {
    const { rerender } = render(<Alert tone="error">Failed</Alert>)
    expect(screen.getByRole('alert')).toHaveTextContent('Failed')
    rerender(<Alert tone="success" title="Saved">All good</Alert>)
    expect(screen.getByRole('status')).toHaveTextContent('SavedAll good')
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
  })

  it('can be dismissed', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(<Alert tone="warning" onDismiss={onDismiss}>Careful</Alert>)
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})

describe('Switch', () => {
  function Controlled({ disabled = false }: { disabled?: boolean }) {
    const [on, setOn] = useState(false)
    return <Switch checked={on} onChange={setOn} label="Automatic backups" description="Runs nightly" disabled={disabled} />
  }

  it('toggles from the switch and from its label', async () => {
    const user = userEvent.setup()
    render(<Controlled />)
    const control = screen.getByRole('switch', { name: 'Automatic backups' })
    expect(control).toHaveAttribute('aria-checked', 'false')
    expect(control).toHaveAccessibleDescription('Runs nightly')

    await user.click(control)
    expect(control).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByText('Automatic backups'))
    expect(control).toHaveAttribute('aria-checked', 'false')
  })

  it('supports an aria-label without a visible label and a disabled state', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Switch checked onChange={onChange} aria-label="Enabled" disabled />)
    const control = screen.getByRole('switch', { name: 'Enabled' })
    expect(control).toBeDisabled()
    await user.click(control)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('Pagination', () => {
  it('moves between pages and disables the ends', async () => {
    const user = userEvent.setup()
    const onPageChange = vi.fn()
    const { rerender } = render(<Pagination page={1} pageCount={3} onPageChange={onPageChange} />)
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    expect(onPageChange).toHaveBeenCalledWith(2)

    rerender(<Pagination page={3} pageCount={3} onPageChange={onPageChange} summary="Page 3 of 3 · 60 entries" />)
    expect(screen.getByText('Page 3 of 3 · 60 entries')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(onPageChange).toHaveBeenLastCalledWith(2)
  })

  it('hides a single page and supports hasNext lists', () => {
    const { container, rerender } = render(<Pagination page={1} pageCount={1} onPageChange={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<Pagination page={2} hasNext={false} onPageChange={vi.fn()} />)
    expect(screen.getByText('Page 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled()
  })
})

describe('Field', () => {
  it('associates the label, hint and error with a cloned control', () => {
    render(<Field label="Name" hint="Shown publicly" error="Required" required><input className="input-m3" /></Field>)
    const input = screen.getByRole('textbox', { name: /Name/ })
    expect(input).toHaveAccessibleDescription('Shown publicly Required')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-required', 'true')
  })

  it('keeps an existing child id and supports a render function', () => {
    const { unmount } = render(<Field label="URL"><input id="monitor-url" /></Field>)
    expect(screen.getByLabelText('URL')).toHaveAttribute('id', 'monitor-url')
    unmount()

    render(<Field label="Timeout" variant="plain">{(control) => <div><input type="number" {...control} /> ms</div>}</Field>)
    expect(screen.getByRole('spinbutton', { name: 'Timeout' })).toBeInTheDocument()
  })
})

describe('State views', () => {
  it('renders loading, error with retry and empty states', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(<>
      <LoadingState label="Loading monitors…" />
      <ErrorState message="Could not load monitors" onRetry={onRetry} />
      <EmptyState title="No monitors yet" description="Add your first monitor" action={<button type="button">Add monitor</button>} />
    </>)
    expect(screen.getByRole('status')).toHaveTextContent('Loading monitors…')
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load monitors')
    await user.click(screen.getByRole('button', { name: /Try again/ }))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(screen.getByText('No monitors yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add monitor' })).toBeInTheDocument()
  })

  it('renders the standalone empty state as a compact card by default', () => {
    const { container } = render(<EmptyState icon="warning" title="No incidents yet" />)
    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveClass('rounded-2xl')
    expect(root.style.border).toBe('1px solid var(--m3-outline-variant)')
    expect(root.style.background).toBe('var(--m3-surface-container-low)')
    expect(screen.getByText('warning')).toHaveAttribute('class', 'material-symbols-outlined')
  })

  it('renders the inset variant as a divided row without its own card', () => {
    const { container } = render(<EmptyState variant="inset" title="No backups yet" action={<button type="button">Enable</button>} />)
    const root = container.firstElementChild as HTMLElement
    expect(root).not.toHaveClass('rounded-2xl')
    expect(root.style.borderTop).toBe('1px solid var(--m3-outline-variant)')
    expect(root.style.background).toBe('')
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument()
  })

  it('renders an empty table row spanning every column with an inline link', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn()
    render(
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Status</th></tr></thead>
        <tbody>
          <EmptyTableRow colSpan={3} icon="notifications_off" title="No channels yet" description={<>Alerts stay silent until you <EmptyStateLink onClick={onAdd}>add a channel</EmptyStateLink>.</>} />
        </tbody>
      </table>,
    )
    const cell = screen.getByRole('cell')
    expect(cell).toHaveAttribute('colspan', '3')
    expect(within(cell).getByText('No channels yet')).toBeInTheDocument()
    expect((cell.firstElementChild as HTMLElement).style.border).toBe('')
    await user.click(screen.getByRole('button', { name: 'add a channel' }))
    expect(onAdd).toHaveBeenCalledOnce()
  })

  it('renders quick-start tiles that report the picked option', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(
      <QuickStartPanel
        title="Where should alerts go?"
        options={[{ key: 'email', label: 'Email', hint: 'Uses SMTP', icon: 'M' }, { key: 'slack', label: 'Slack', hint: 'Incoming webhook', icon: 'S' }]}
        onPick={onPick}
      />,
    )
    const panel = screen.getByRole('region', { name: 'Where should alerts go?' })
    await user.click(within(panel).getByRole('button', { name: /Slack/ }))
    expect(onPick).toHaveBeenCalledWith('slack')
  })

  it('has sensible defaults', () => {
    render(<><LoadingState /><ErrorState /></>)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Try again/ })).not.toBeInTheDocument()
  })
})

describe('Toast', () => {
  afterEach(() => { vi.useRealTimers() })

  function Trigger() {
    const toast = useToast()
    return <>
      <button type="button" onClick={() => toast.success('Monitor saved')}>Save</button>
      <button type="button" onClick={() => toast.error('Save failed')}>Fail</button>
      <button type="button" onClick={() => toast.info('Sticky', { duration: 0 })}>Info</button>
    </>
  }

  it('shows success and error toasts that can be dismissed', async () => {
    const user = userEvent.setup()
    render(<ToastProvider><Trigger /></ToastProvider>)

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await user.click(screen.getByRole('button', { name: 'Fail' }))
    expect(screen.getByRole('status')).toHaveTextContent('Monitor saved')
    expect(screen.getByRole('alert')).toHaveTextContent('Save failed')

    await user.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]!)
    expect(screen.queryByText('Monitor saved')).not.toBeInTheDocument()
  })

  it('dismisses itself after the default duration unless it is sticky', () => {
    vi.useFakeTimers()
    render(<ToastProvider><Trigger /></ToastProvider>)
    act(() => { screen.getByRole('button', { name: 'Save' }).click() })
    act(() => { screen.getByRole('button', { name: 'Info' }).click() })
    expect(screen.getByText('Monitor saved')).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByText('Monitor saved')).not.toBeInTheDocument()
    expect(screen.getByText('Sticky')).toBeInTheDocument()
  })

  it('is a no-op outside the provider', async () => {
    const user = userEvent.setup()
    render(<Trigger />)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.queryByText('Monitor saved')).not.toBeInTheDocument()
  })
})
