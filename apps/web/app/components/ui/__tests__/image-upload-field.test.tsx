/**
 * image-upload-field.tsx — unit tests for `<ImageUploadField>`.
 *
 * task-i18n-stage3a (Task 1), fix-round 2 (MUT-1/MUT-2). ZERO tests existed
 * for this file before this round — the fix-round-1 mutation-gate follow-up
 * flagged it in "Remaining gap, itemized" (2 survived / 9 no-coverage on a
 * scoped `mutation:changed` run) as pre-existing debt from Steps 1-7.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ImageUploadField, type ImageUploadFieldValue } from '../image-upload-field'

beforeEach(async () => {
  vi.clearAllMocks()
  await loadCatalog('uk')
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const mockMutateAsync = vi.fn()
vi.mock('@/hooks/use-documents', () => ({
  useUploadDocument: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}))

// Real thumbnail fetching needs network — stub so this file exercises only
// ImageUploadField's own props to it (`alt`, in particular — MUT-1).
vi.mock('@/components/documents/document-image', () => ({
  DocumentImage: ({ alt }: { alt: string }) => <img alt={alt} src="mock" />,
}))

function renderField(value: ImageUploadFieldValue, onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ImageUploadField value={value} onChange={onChange} category="AVATAR" />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

function makeFile(name: string, type: string, sizeBytes: number): File {
  const file = new File([new Uint8Array(sizeBytes)], name, { type })
  return file
}

describe('ImageUploadField — client-side validation (MUT-1)', () => {
  it('rejects an unsupported MIME type and names it in the toast', async () => {
    // `applyAccept: false` — the input's own `accept` attribute would
    // otherwise make userEvent silently refuse to attach a mismatched
    // file (mimicking a native file-picker filter), never firing the
    // change event this test needs to reach `handleFile`'s OWN
    // client-side MIME check at all.
    const user = userEvent.setup({ applyAccept: false })
    renderField({ documentId: null, externalUrl: null })

    const input = screen.getByTestId('image-upload-field-file-input')
    const badFile = makeFile('doc.gif', 'image/gif', 100)
    await user.upload(input, badFile)

    expect(toast.error).toHaveBeenCalledWith(
      'Тип image/gif не підтримується. Можна завантажити PNG, JPEG або WebP',
    )
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })

  // MUT-1: `file.type || 'unknown'` — a file with NO type at all (some OS/
  // browser combinations omit it for unrecognized extensions) must still
  // name SOMETHING in the toast, not leave the sentence with a blank.
  it('falls back to "unknown" in the toast when the rejected file has an empty MIME type', async () => {
    const user = userEvent.setup({ applyAccept: false })
    renderField({ documentId: null, externalUrl: null })

    const input = screen.getByTestId('image-upload-field-file-input')
    const noTypeFile = makeFile('mystery', '', 100)
    await user.upload(input, noTypeFile)

    expect(toast.error).toHaveBeenCalledWith(
      'Тип unknown не підтримується. Можна завантажити PNG, JPEG або WebP',
    )
  })

  it('rejects a file over the size limit and names the exact 10 MB cap', async () => {
    const user = userEvent.setup()
    renderField({ documentId: null, externalUrl: null })

    const input = screen.getByTestId('image-upload-field-file-input')
    // 10 * 1024 * 1024 + 1 bytes — one over DOCUMENT_MAX_BYTES.
    const tooBig = makeFile('big.png', 'image/png', 10 * 1024 * 1024 + 1)
    await user.upload(input, tooBig)

    // MUT-1: `Math.round(DOCUMENT_MAX_BYTES / 1024 / 1024)` — a mutant
    // reordering the divisions to `/1024*1024` or `*1024/1024` both
    // produce 10485760 instead of 10, which this exact string catches.
    expect(toast.error).toHaveBeenCalledWith('Файл більший за 10 МБ — виберіть інший')
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })

  it('accepts a valid file within the size limit and starts the upload', async () => {
    mockMutateAsync.mockResolvedValue({ id: 'doc-1' })
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderField({ documentId: null, externalUrl: null }, onChange)

    const input = screen.getByTestId('image-upload-field-file-input')
    const goodFile = makeFile('avatar.png', 'image/png', 1024)
    await user.upload(input, goodFile)

    expect(mockMutateAsync).toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe('ImageUploadField — upload failure fallback message (MUT-1)', () => {
  it('shows the generic fallback message when the upload rejects with a non-Error value', async () => {
    mockMutateAsync.mockRejectedValue('a raw string rejection, not an Error instance')
    const user = userEvent.setup()
    renderField({ documentId: null, externalUrl: null })

    const input = screen.getByTestId('image-upload-field-file-input')
    const goodFile = makeFile('avatar.png', 'image/png', 1024)
    await user.upload(input, goodFile)

    // The progress state's own error message ends up in the "retry" UI
    // (progress.state.phase becomes 'error'), which swaps the helper text
    // below the picker button.
    expect(
      await screen.findByText('Натисніть ще раз, щоб повторити завантаження.'),
    ).toBeInTheDocument()
    // MUT-1: the FALLBACK message itself — `<UploadProgress>` (rendered
    // inside the picker button once phase !== 'idle') shows
    // `state.error`, which is exactly this fallback string for a
    // non-Error rejection.
    expect(screen.getByText('Не вдалося завантажити файл')).toBeInTheDocument()
  })
})

describe('ImageUploadField — preview alt text + clear button (MUT-1)', () => {
  it('names the preview image and the clear button in their own catalog strings', () => {
    renderField({ documentId: 'doc-1', externalUrl: null })

    expect(screen.getByAltText('Завантажений файл')).toBeInTheDocument()
    expect(screen.getByLabelText('Очистити зображення')).toBeInTheDocument()
  })
})
