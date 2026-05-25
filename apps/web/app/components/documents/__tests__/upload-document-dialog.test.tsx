import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { UploadDocumentDialog } from '../upload-document-dialog'

// Mock the upload hook so the dialog doesn't try to hit the network during
// interaction tests. We assert on the props passed in by the dialog.
const mockMutate = vi.fn()
vi.mock('@/hooks/use-documents', () => ({
  useUploadDocument: () => ({
    mutate: mockMutate,
    isPending: false,
  }),
}))

function renderDialog(open = true) {
  const onOpenChange = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const utils = render(
    <QueryClientProvider client={qc}>
      <Toaster />
      <UploadDocumentDialog
        open={open}
        onOpenChange={onOpenChange}
        defaultCategory="RESUME"
      />
    </QueryClientProvider>,
  )
  return { ...utils, onOpenChange }
}

beforeEach(() => {
  mockMutate.mockReset()
})

describe('UploadDocumentDialog', () => {
  it('renders dropzone, category select, and disabled submit when no file', () => {
    renderDialog()
    expect(screen.getByTestId('upload-dropzone')).toBeInTheDocument()
    expect(screen.getByTestId('upload-category-select')).toBeInTheDocument()
    const submit = screen.getByTestId('upload-submit')
    expect(submit).toBeDisabled()
  })

  it('keeps submit disabled while no file is selected', async () => {
    renderDialog()
    const submit = screen.getByTestId('upload-submit')
    expect(submit).toBeDisabled()
  })

  it('accepts a valid PDF via hidden input and enables submit', async () => {
    renderDialog()
    const input = screen.getByTestId('upload-file-input') as HTMLInputElement
    const file = new File(['%PDF-1.4 test'], 'cv.pdf', { type: 'application/pdf' })
    await userEvent.upload(input, file)
    await waitFor(() => {
      expect(screen.getByText('cv.pdf')).toBeInTheDocument()
    })
    expect(screen.getByTestId('upload-submit')).not.toBeDisabled()
  })

  it('rejects an oversized file (> 10 MB) without enabling submit', async () => {
    renderDialog()
    const input = screen.getByTestId('upload-file-input') as HTMLInputElement
    const big = new File(
      [new Uint8Array(11 * 1024 * 1024)],
      'huge.pdf',
      { type: 'application/pdf' },
    )
    await userEvent.upload(input, big)
    // Submit must remain disabled — the file was rejected at the client gate.
    expect(screen.getByTestId('upload-submit')).toBeDisabled()
  })

  it('rejects an unsupported MIME (e.g. text/plain)', async () => {
    renderDialog()
    const input = screen.getByTestId('upload-file-input') as HTMLInputElement
    const bad = new File(['hello'], 'note.txt', { type: 'text/plain' })
    await userEvent.upload(input, bad)
    expect(screen.getByTestId('upload-submit')).toBeDisabled()
  })

  it('toggles dropzone visual state on drag events', () => {
    renderDialog()
    const dropzone = screen.getByTestId('upload-dropzone')
    expect(dropzone).not.toHaveAttribute('data-dragging')
    fireEvent.dragEnter(dropzone)
    expect(dropzone).toHaveAttribute('data-dragging', 'true')
  })

  it('calls the upload mutation with the chosen file on submit', async () => {
    renderDialog()
    const input = screen.getByTestId('upload-file-input') as HTMLInputElement
    const file = new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' })
    await userEvent.upload(input, file)
    await userEvent.click(screen.getByTestId('upload-submit'))
    expect(mockMutate).toHaveBeenCalledTimes(1)
    const args = mockMutate.mock.calls[0]?.[0] as { file: File; category: string }
    expect(args.file.name).toBe('doc.pdf')
    expect(args.category).toBe('RESUME')
  })
})
