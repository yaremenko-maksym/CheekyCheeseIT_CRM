import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { UploadDocumentDialog } from '../upload-document-dialog'

// task-i18n-stage3a (Task 1) blast-radius: this dialog renders the shared
// `UploadProgress` (`components/ui/`), which now calls `useLingui()` —
// outside this file's own perimeter (`components/documents/**` migrates in
// a later wave), so only the render wrapper changes here.
beforeEach(async () => {
  await loadCatalog('uk')
})

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
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <Toaster />
        <UploadDocumentDialog open={open} onOpenChange={onOpenChange} defaultCategory="RESUME" />
      </QueryClientProvider>
    </I18nTestProvider>,
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

  it('rejects an oversized file (> 10 MB) without enabling submit, and names both sizes in the toast', async () => {
    renderDialog()
    const input = screen.getByTestId('upload-file-input') as HTMLInputElement
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'huge.pdf', {
      type: 'application/pdf',
    })
    await userEvent.upload(input, big)
    // Submit must remain disabled — the file was rejected at the client gate.
    expect(screen.getByTestId('upload-submit')).toBeDisabled()
    // task-i18n-stage3a (Task 2) — mutation-gate gap-fill: the toast names
    // BOTH the limit (10.0 MB) and the picked file's own size (11.0 MB),
    // through `formatBytes(bytes, locale)` — nothing asserted on this text
    // before. The dialog's own "Максимальний розмір: 10,0 МБ…" helper text
    // repeats the limit, so match on the toast's FULL sentence (unique).
    // task-i18n-stage3e-pr3: one sentence, names both sizes AND the next step.
    await waitFor(() => {
      expect(
        screen.getByText('Файл завеликий (11,0 МБ) — оберіть файл менше 10,0 МБ'),
      ).toBeInTheDocument()
    })
  })

  it('rejects an unsupported MIME (e.g. text/plain)', async () => {
    renderDialog()
    const input = screen.getByTestId('upload-file-input') as HTMLInputElement
    const bad = new File(['hello'], 'note.txt', { type: 'text/plain' })
    // `userEvent.upload` honours the input's `accept` and would drop the file
    // before the handler runs; a raw change event exercises the client gate.
    fireEvent.change(input, { target: { files: [bad] } })
    expect(screen.getByTestId('upload-submit')).toBeDisabled()
    await waitFor(() => {
      expect(
        screen.getByText('Цей формат не підтримується — оберіть PDF, JPG, PNG, WebP або HEIC'),
      ).toBeInTheDocument()
    })
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

  // ---- task-i18n-stage3e-pr3: server-side failure → status-based text ------
  // (COPY-H-docs-6: never the raw axios `e.message`, always a next step.)
  async function submitAndFail(error: unknown) {
    mockMutate.mockImplementation(
      (_vars: unknown, opts: { onError?: (e: unknown) => void } | undefined) => {
        opts?.onError?.(error)
      },
    )
    renderDialog()
    const input = screen.getByTestId('upload-file-input') as HTMLInputElement
    await userEvent.upload(input, new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' }))
    await userEvent.click(screen.getByTestId('upload-submit'))
    return screen.findByRole('alert')
  }

  function axiosLike(status: number, message: string) {
    return Object.assign(new Error(message), { response: { status, data: {} } })
  }

  it('413 from the server names the limit and the next step, not the axios text', async () => {
    const alert = await submitAndFail(axiosLike(413, 'Request failed with status code 413'))
    expect(alert).toHaveTextContent('Файл завеликий — оберіть файл менше 10,0 МБ')
    expect(alert).not.toHaveTextContent('Request failed')
  })

  it('415 from the server tells which formats are accepted', async () => {
    const alert = await submitAndFail(axiosLike(415, 'Request failed with status code 415'))
    expect(alert).toHaveTextContent(
      'Цей формат не підтримується — оберіть PDF, JPG, PNG, WebP або HEIC',
    )
  })

  it('any other failure with an empty message falls back to an actionable sentence', async () => {
    const alert = await submitAndFail(new Error(''))
    expect(alert).toHaveTextContent('Не вдалося завантажити документ — спробуйте ще раз')
  })

  it('category options come from the hub (one word per category) and button reads «Завантажити файл»', async () => {
    renderDialog()
    expect(screen.getByTestId('upload-submit')).toHaveTextContent('Завантажити файл')
    await userEvent.click(screen.getByTestId('upload-category-select'))
    expect(await screen.findByRole('option', { name: 'Скан' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Договір' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Скан документа' })).not.toBeInTheDocument()
  })

  it('renders in English when the en catalog is active', async () => {
    await loadCatalog('en')
    try {
      renderDialog()
      expect(screen.getByText('Upload document')).toBeInTheDocument()
      expect(screen.getByTestId('upload-submit')).toHaveTextContent('Upload a file')
      const input = screen.getByTestId('upload-file-input') as HTMLInputElement
      const big = new File([new Uint8Array(11 * 1024 * 1024)], 'huge.pdf', {
        type: 'application/pdf',
      })
      await userEvent.upload(input, big)
      await waitFor(() => {
        expect(
          screen.getByText('The file is too large (11.0 MB) — choose a file under 10.0 MB'),
        ).toBeInTheDocument()
      })
    } finally {
      await loadCatalog('uk')
    }
  })
})
