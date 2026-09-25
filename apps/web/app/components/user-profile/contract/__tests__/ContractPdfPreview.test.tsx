/**
 * ContractPdfPreview.test.tsx
 *
 * Unit tests for ContractPdfPreview component.
 * Covers: PDF load success, generic error, 429 throttle toast, isDirty disables refresh button,
 * AbortController cleanup on unmount.
 */

import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ContractPdfPreview } from '../ContractPdfPreview'

// Note: this component mounts a real `<iframe src={blobUrl}>`. happy-dom would
// otherwise try to navigate the iframe to that `blob:` URL and reject
// asynchronously with a stray DOMException, which manifested as a load-dependent
// flake under the parallel pre-push run. That async navigation is disabled
// globally via `disableIframePageLoading` in apps/web/vitest.config.ts, so the
// iframe assertions below stay deterministic without any per-test stubbing.

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock sonner toast so we can assert calls without real DOM toasts
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

// Mock fetchContractPdfBlob from the hook module
vi.mock('../useEmployeeContract', () => ({
  fetchContractPdfBlob: vi.fn(),
}))

import { toast } from 'sonner'
import { fetchContractPdfBlob } from '../useEmployeeContract'

// Fake blob URL helpers
const FAKE_BLOB_URL = 'blob:http://localhost/fake-pdf-uuid'
const mockRevoke = vi.fn()

const mockFetch = fetchContractPdfBlob as ReturnType<typeof vi.fn>
const mockToastError = toast.error as ReturnType<typeof vi.fn>

// URL.createObjectURL / revokeObjectURL are not in happy-dom — stub them
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

beforeEach(async () => {
  URL.createObjectURL = vi.fn().mockReturnValue(FAKE_BLOB_URL)
  URL.revokeObjectURL = vi.fn()
  mockRevoke.mockReset()
  mockToastError.mockReset()
  mockFetch.mockReset()
  await loadCatalog('uk')
})

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderPreview(isDirty = false, userId = 'user-uuid') {
  return render(
    <I18nTestProvider>
      <TooltipProvider>
        <ContractPdfPreview userId={userId} isDirty={isDirty} />
      </TooltipProvider>
    </I18nTestProvider>,
  )
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ContractPdfPreview', () => {
  it('renders the refresh button', () => {
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
    renderPreview()
    expect(screen.getByTestId('contract-pdf-refresh-btn')).toBeInTheDocument()
  })

  it('shows PDF iframe after successful load', async () => {
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })

    renderPreview()

    await waitFor(() => {
      // Found by its accessible title (ContractPdfPreview.tsx sets one) instead
      // of document.querySelector — task-lint-teeth.
      const iframe = screen.getByTitle('Попередній перегляд контракту')
      expect(iframe).toBeInTheDocument()
      expect(iframe).toHaveAttribute('src', expect.stringContaining('blob:'))
    })

    expect(mockToastError).not.toHaveBeenCalled()
  })

  // task-i18n-stage3b (Task 1), mutation-gate coverage — `aria-label` and
  // `title` share the same `t` literal but are two separate JSX attribute
  // expressions (two separate mutants); the existing test above only ever
  // read `title` via `getByTitle`.
  it('the iframe carries the same text as BOTH title and aria-label', async () => {
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
    renderPreview()
    await waitFor(() => {
      const iframe = screen.getByTitle('Попередній перегляд контракту')
      expect(iframe).toHaveAttribute('aria-label', 'Попередній перегляд контракту')
    })
  })

  // The `<object>` fallback content (native browser fallback for iframe
  // unsupported cases) is a static child of the SAME `blobUrl && !hasError`
  // block as the iframe itself — React renders it regardless of whether a
  // real browser would show it, so it's reachable straight from a normal
  // successful load, no separate `hasError` state needed.
  it('renders the <object> fallback text and download link with the shared filename', async () => {
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
    renderPreview()
    await waitFor(() => {
      expect(screen.getByText(/Вбудований перегляд PDF недоступний/)).toBeInTheDocument()
    })
    const link = screen.getByRole('link', { name: 'Завантажити контракт' })
    expect(link).toHaveAttribute('download', 'Контракт — попередній перегляд.pdf')
  })

  it('shows error state and generic toast on non-429 fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network Error'))

    renderPreview()

    await waitFor(() => {
      expect(screen.getByTestId('contract-pdf-error')).toBeInTheDocument()
    })

    expect(mockToastError).toHaveBeenCalledWith('Не вдалося завантажити PDF попереднього перегляду')
  })

  it('shows 429 throttle toast when fetch returns 429 response error', async () => {
    const throttleError = Object.assign(new Error('Too Many Requests'), {
      response: { status: 429 },
    })
    mockFetch.mockRejectedValue(throttleError)

    renderPreview()

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'Забагато запитів поспіль. Зачекайте трохи і спробуйте ще раз',
      )
    })
    expect(screen.getByTestId('contract-pdf-error')).toBeInTheDocument()
  })

  it('refresh button is disabled while isDirty=true', async () => {
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })

    renderPreview(true /* isDirty */)

    await waitFor(() => {
      expect(screen.getByTestId('contract-pdf-refresh-btn')).toBeDisabled()
    })
  })

  // task-i18n-stage3b (Task 1), mutation-gate coverage — `isDirty &&
  // <TooltipContent>` had no assertion on EITHER side of the conditional:
  // present when dirty, absent when clean. The Radix `TooltipContent`
  // renders into the DOM immediately in this codebase's test setup (no
  // hover/portal timing needed — same pattern already relied on elsewhere
  // in this file's own `TooltipProvider` wrapper).
  it('isDirty=true renders the "save first" tooltip content on hover', async () => {
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
    const user = userEvent.setup()
    renderPreview(true /* isDirty */)
    await waitFor(() => expect(screen.getByTestId('contract-pdf-refresh-btn')).toBeDisabled())
    // Radix Tooltip only mounts TooltipContent once open (hover/focus) —
    // `userEvent.hover` fires pointer-enter on the target AND its ancestor
    // chain (including the wrapping `<span>` TooltipTrigger), so hovering
    // the button itself is enough even though it's disabled.
    await user.hover(screen.getByTestId('contract-pdf-refresh-btn'))
    // Radix renders the tooltip text TWICE (visible content + a visually-
    // hidden `role="tooltip"` span for screen readers) — assert via the
    // unambiguous role instead of `getByText`.
    await waitFor(
      () => {
        expect(screen.getByRole('tooltip')).toHaveTextContent(
          'Спочатку збережіть, щоб оновити перегляд',
        )
      },
      { timeout: 3000 },
    )
  })

  it('isDirty=false renders no "save first" tooltip content at all', async () => {
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
    renderPreview(false /* isDirty */)
    await waitFor(() => {
      expect(screen.getByTestId('contract-pdf-refresh-btn')).toBeEnabled()
    })
    expect(screen.queryByText('Спочатку збережіть, щоб оновити перегляд')).not.toBeInTheDocument()
  })

  it('refresh button is enabled when isDirty=false (clean)', async () => {
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })

    renderPreview(false /* isDirty */)

    await waitFor(() => {
      // Disabled during loading (isLoading=true); wait until load resolves
      expect(screen.getByTestId('contract-pdf-refresh-btn')).toBeEnabled()
    })
  })

  it('clicking refresh button triggers a new PDF fetch', async () => {
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
    const user = userEvent.setup()

    renderPreview(false)

    // Wait for initial load
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    // Click refresh
    await act(async () => {
      await user.click(screen.getByTestId('contract-pdf-refresh-btn'))
    })

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
  })

  it('AbortController: cleanup aborts the in-flight fetch on unmount', async () => {
    // Simulate a never-resolving fetch so we can catch the abort
    let capturedSignal: AbortSignal | undefined
    mockFetch.mockImplementation((_userId: string, signal?: AbortSignal) => {
      capturedSignal = signal
      return new Promise(() => {
        /* never resolves */
      })
    })

    const { unmount } = renderPreview()

    // Give the component a tick to start the fetch
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(capturedSignal).toBeDefined()
    expect(capturedSignal!.aborted).toBe(false)

    unmount()

    expect(capturedSignal!.aborted).toBe(true)
  })

  it('AbortController: new userId triggers abort of previous fetch', async () => {
    let firstSignal: AbortSignal | undefined
    let callCount = 0

    mockFetch.mockImplementation((_userId: string, signal?: AbortSignal) => {
      callCount++
      if (callCount === 1) {
        firstSignal = signal
        return new Promise(() => {
          /* never resolves */
        })
      }
      return Promise.resolve({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
    })

    const { rerender } = render(
      <I18nTestProvider>
        <TooltipProvider>
          <ContractPdfPreview userId="user-1" isDirty={false} />
        </TooltipProvider>
      </I18nTestProvider>,
    )

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(firstSignal?.aborted).toBe(false)

    // Change userId — triggers new fetch, old controller should be aborted
    rerender(
      <I18nTestProvider>
        <TooltipProvider>
          <ContractPdfPreview userId="user-2" isDirty={false} />
        </TooltipProvider>
      </I18nTestProvider>,
    )

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(firstSignal?.aborted).toBe(true)
  })

  // ─── Download button tests ─────────────────────────────────────────────────

  it('renders the download button', () => {
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
    renderPreview()
    expect(screen.getByTestId('contract-pdf-download-btn')).toBeInTheDocument()
  })

  it('download button is enabled by default (not disabled by isDirty)', async () => {
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
    // Even with isDirty=true, download button should be enabled
    renderPreview(true /* isDirty */)
    await waitFor(() => {
      expect(screen.getByTestId('contract-pdf-download-btn')).toBeEnabled()
    })
  })

  it('clicking download button triggers fetchContractPdfBlob and creates anchor click', async () => {
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
    const user = userEvent.setup()

    // Stub anchor click to avoid JSDOM navigation issues
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    renderPreview(false)

    // Wait for initial load fetch
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    // Verify button is in DOM
    const downloadBtn = await screen.findByTestId('contract-pdf-download-btn')
    expect(downloadBtn).toBeInTheDocument()

    // Click download button — triggers a new (non-signal) fetchContractPdfBlob call
    await user.click(downloadBtn)

    // fetchContractPdfBlob should be called a 2nd time (no AbortSignal arg)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    // Anchor was clicked
    expect(clickSpy).toHaveBeenCalledTimes(1)

    clickSpy.mockRestore()
  })

  it('download button shows toast.error on non-429 fetch failure', async () => {
    // loadPdf (on mount) always resolves; downloadPdf rejects on second call
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
    const user = userEvent.setup()

    renderPreview(false)

    // Wait for initial load
    const downloadBtn = await screen.findByTestId('contract-pdf-download-btn')
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    // Now make subsequent calls (download) reject
    mockFetch.mockRejectedValue(new Error('Download failed'))

    await user.click(downloadBtn)

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Не вдалося завантажити PDF')
    })
  })

  it('download button shows 429 toast on throttle error', async () => {
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
    const user = userEvent.setup()

    renderPreview(false)

    const downloadBtn = await screen.findByTestId('contract-pdf-download-btn')
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    // Make download call return 429
    const throttleError = Object.assign(new Error('Too Many Requests'), {
      response: { status: 429 },
    })
    mockFetch.mockRejectedValue(throttleError)

    await user.click(downloadBtn)

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'Забагато запитів поспіль. Зачекайте трохи і спробуйте ще раз',
      )
    })
  })
})
