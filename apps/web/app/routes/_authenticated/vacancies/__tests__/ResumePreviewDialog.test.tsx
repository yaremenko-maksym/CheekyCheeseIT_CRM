/**
 * ResumePreviewDialog.test.tsx — task-candidate-card-resume (AC2).
 *
 * Isolates the DIALOG's own branch selection — `useApplicationResumeBlob`
 * itself is mocked (already covered directly in use-resume-blob.test.tsx),
 * and `PdfPreview` is the same generic component `document-detail-dialog`
 * uses for RESUME-category documents (own coverage in pdf-preview.test.tsx).
 *
 * Pins:
 * 1. isUnsupportedFormat=true -> honest "unsupported format" card, no
 *    "browser doesn't support" wording (see #470 — that exact phrasing was
 *    a site-policy bug, not a browser limitation).
 * 2. isUnsupportedFormat=false -> renders PdfPreview with the blob props
 *    forwarded through unchanged.
 * 3. Closed (open=false) -> no dialog content in the DOM.
 * 4. Download button — blob already loaded (the common case, since the
 *    preview just fetched it): downloads straight from the blob, NO fresh
 *    presigned-URL request (code-review round 2 — a presigned URL is a
 *    600s bearer credential that shouldn't linger in the browser's
 *    downloads history when a blob is already sitting right there).
 * 5. Download button — no blob yet (still loading / unsupported / error):
 *    falls back to the SAME mobile-safe window.location.href navigation as
 *    CandidateCard's own button (AC1), guarded by safeExternalHref.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { VacancyApplication } from '@crm/shared'

const apiGet = vi.fn()
vi.mock('@/lib/axios', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}))

const useApplicationResumeBlobMock = vi.fn()
vi.mock('@/hooks/use-resume-blob', () => ({
  useApplicationResumeBlob: (...args: unknown[]) => useApplicationResumeBlobMock(...args),
}))

import { ResumePreviewDialog } from '../components/ResumePreviewDialog'

function makeApplication(overrides: Partial<VacancyApplication> = {}): VacancyApplication {
  return {
    id: 'app-1',
    vacancyId: 'vac-1',
    fullName: 'Иван Петров',
    email: 'ivan@example.com',
    telegram: null,
    linkedinUrl: null,
    githubUrl: null,
    coverLetter: null,
    resumeSizeBytes: 12345,
    status: 'NEW',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function renderDialog(open: boolean, onOpenChange: (open: boolean) => void = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ResumePreviewDialog
        open={open}
        onOpenChange={onOpenChange}
        vacancyId="vac-1"
        application={makeApplication()}
      />
    </QueryClientProvider>,
  )
}

describe('ResumePreviewDialog', () => {
  beforeEach(() => {
    apiGet.mockReset()
    useApplicationResumeBlobMock.mockReset()
    useApplicationResumeBlobMock.mockReturnValue({
      blobUrl: null,
      isLoading: true,
      hasError: false,
      isUnsupportedFormat: false,
    })
  })

  it('closed: no dialog content in the DOM', () => {
    renderDialog(false)
    expect(screen.queryByTestId('resume-preview-dialog')).not.toBeInTheDocument()
  })

  it('open: renders the title with the candidate name', () => {
    renderDialog(true)
    expect(screen.getByTestId('resume-preview-title')).toHaveTextContent('Иван Петров')
  })

  it('open + PDF blob ready: renders PdfPreview (iframe with the blob src)', () => {
    useApplicationResumeBlobMock.mockReturnValue({
      blobUrl: 'blob:http://localhost/fake-resume-uuid',
      isLoading: false,
      hasError: false,
      isUnsupportedFormat: false,
    })
    renderDialog(true)
    const preview = screen.getByTestId('candidate-resume-preview')
    const iframe = preview.querySelector('iframe')
    expect(iframe?.getAttribute('src')).toBe('blob:http://localhost/fake-resume-uuid')
  })

  it('unsupported format: honest card, no "browser doesn\'t support" wording (regression for #470)', () => {
    useApplicationResumeBlobMock.mockReturnValue({
      blobUrl: null,
      isLoading: false,
      hasError: false,
      isUnsupportedFormat: true,
    })
    renderDialog(true)
    expect(screen.queryByTestId('candidate-resume-preview')).not.toBeInTheDocument()
    expect(screen.getByText(/Предпросмотр недоступен для этого формата файла/)).toBeInTheDocument()
    expect(screen.queryByText(/браузер не поддерживает/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/не поддерживается браузером/i)).not.toBeInTheDocument()
  })

  describe('download button — blob already loaded (code-review round 2)', () => {
    it('downloads from the blob directly — no presigned-URL fetch at all', () => {
      useApplicationResumeBlobMock.mockReturnValue({
        blobUrl: 'blob:http://localhost/fake-resume-uuid',
        isLoading: false,
        hasError: false,
        isUnsupportedFormat: false,
      })
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
      const appendSpy = vi.spyOn(document.body, 'appendChild')

      renderDialog(true)
      fireEvent.click(screen.getByTestId('resume-preview-download'))

      expect(clickSpy).toHaveBeenCalledTimes(1)
      expect(apiGet).not.toHaveBeenCalled()
      const anchor = appendSpy.mock.calls.find(
        (call) => call[0] instanceof HTMLAnchorElement,
      )?.[0] as HTMLAnchorElement
      expect(anchor).toBeDefined()
      expect(anchor.href).toBe('blob:http://localhost/fake-resume-uuid')
      expect(anchor.download).toBe('Иван Петров.pdf')

      clickSpy.mockRestore()
      appendSpy.mockRestore()
    })
  })

  describe('download button — no blob yet, fallback (task-candidate-card-resume AC1 — mobile-safe navigation)', () => {
    const originalLocation = window.location

    beforeEach(() => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...originalLocation, href: '' },
      })
    })

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      })
    })

    it('refetches the presigned download URL then navigates via window.location.href', async () => {
      apiGet.mockResolvedValue({
        data: { url: 'https://r2.example/resume.pdf', expiresAt: '2026-01-01T00:10:00.000Z' },
      })
      renderDialog(true)
      fireEvent.click(screen.getByTestId('resume-preview-download'))
      await waitFor(() => expect(window.location.href).toBe('https://r2.example/resume.pdf'))
      expect(apiGet).toHaveBeenCalledWith('/vacancies/vac-1/applications/app-1/resume-url')
    })

    it('rejects a non-http(s) presigned URL instead of navigating (defence-in-depth)', async () => {
      apiGet.mockResolvedValue({
        data: { url: 'javascript:alert(1)', expiresAt: '2026-01-01T00:10:00.000Z' },
      })
      renderDialog(true)
      fireEvent.click(screen.getByTestId('resume-preview-download'))
      await waitFor(() => expect(apiGet).toHaveBeenCalled())
      expect(window.location.href).toBe('')
    })
  })

  it('close button calls onOpenChange(false)', () => {
    const onOpenChange = vi.fn()
    renderDialog(true, onOpenChange)
    fireEvent.click(screen.getByTestId('resume-preview-close'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
