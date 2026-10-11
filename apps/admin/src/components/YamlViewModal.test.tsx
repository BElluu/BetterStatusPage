import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { YamlViewModal } from './YamlViewModal'

vi.mock('../api/client', () => ({ api: { getText: vi.fn() } }))

const YAML = 'kind: Monitor\nkey: public-site\nname: Public site\n'

function renderModal(props: Partial<React.ComponentProps<typeof YamlViewModal>> = {}) {
  const onClose = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <YamlViewModal kind="Monitor" objectKey="public-site" title="Public site" onClose={onClose} {...props} />
    </QueryClientProvider>,
  )
  return { onClose, user: userEvent.setup() }
}

describe('YamlViewModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getText).mockResolvedValue(YAML)
  })

  it('asks for the one object by kind and key and shows its YAML', async () => {
    renderModal()
    expect(await screen.findByLabelText('YAML', { selector: 'pre' })).toHaveTextContent('key: public-site')
    expect(api.getText).toHaveBeenCalledWith('/admin/config/export?kind=Monitor&key=public-site')
    expect(screen.getByText('Public site')).toBeInTheDocument()
  })

  it('encodes a key rather than trusting it', async () => {
    renderModal({ objectKey: 'a&kind=x' })
    await screen.findByLabelText('YAML', { selector: 'pre' })
    expect(api.getText).toHaveBeenCalledWith('/admin/config/export?kind=Monitor&key=a%26kind%3Dx')
  })

  it('copies and downloads what it shows', async () => {
    const createObjectURL = vi.fn(() => 'blob:yaml')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { user } = renderModal()
    await screen.findByLabelText('YAML', { selector: 'pre' })

    await user.click(screen.getByRole('button', { name: /Download/ }))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    click.mockRestore()
  })

  it('says when the YAML cannot be loaded, and tries again', async () => {
    vi.mocked(api.getText).mockRejectedValueOnce(new Error('There is no Monitor with the key "public-site"'))
    const { user } = renderModal()
    expect(await screen.findByText('There is no Monitor with the key "public-site"')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download/ })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /Try again/ }))
    await waitFor(() => expect(screen.getByLabelText('YAML', { selector: 'pre' })).toBeInTheDocument())
  })

  it('closes from the buttons', async () => {
    const { onClose, user } = renderModal()
    await screen.findByLabelText('YAML', { selector: 'pre' })
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
