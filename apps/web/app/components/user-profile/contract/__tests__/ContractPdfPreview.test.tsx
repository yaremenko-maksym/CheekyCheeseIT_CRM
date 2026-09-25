/**
 * ContractPdfPreview.test.tsx
 *
 * Unit tests for ContractPdfPreview component.
 * Covers: PDF load success, generic error, 429 throttle toast, isDirty disables refresh button,
 * AbortController cleanup on unmount.
 */

import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
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
    // mutation-gate (@crm/web, Fix-round B, CI-MUT): `setIframeLoading(false)`
    // in this SAME catch branch (line 96) survived — the loading overlay
    // (`isLoading || iframeLoading`) is a SIBLING of the error block, not a
    // replacement for it, so a stuck `iframeLoading=true` would visually
    // stack the spinner overlay ON TOP of the error message forever.
    expect(screen.queryByText('Завантаження PDF…')).not.toBeInTheDocument()
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
    // mutation-gate (@crm/web, Fix-round B, CI-MUT): `a.download =
    // \`contract-${userId}.pdf\`` -> `` survived — nothing read the anchor's
    // `download` attribute before this spy.
    const appendChildSpy = vi.spyOn(document.body, 'appendChild')

    renderPreview(false, 'user-download-uuid')

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
    const anchor = appendChildSpy.mock.calls.find(
      ([el]) => el instanceof HTMLAnchorElement,
    )?.[0] as HTMLAnchorElement | undefined
    expect(anchor).toHaveAttribute('download', 'contract-user-download-uuid.pdf')

    clickSpy.mockRestore()
    appendChildSpy.mockRestore()
  })

  it('disables the download button (and shows the animate-pulse icon state) only while its OWN fetch is in flight, re-enabling once it settles', async () => {
    mockFetch.mockResolvedValueOnce({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
    let resolveDownload!: (v: { blobUrl: string; revoke: () => void }) => void
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve
        }),
    )
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const user = userEvent.setup()

    renderPreview(false)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    const downloadBtn = await screen.findByTestId('contract-pdf-download-btn')
    expect(downloadBtn).not.toBeDisabled()

    await user.click(downloadBtn)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))

    // `setIsDownloading(true)` (line 40) — while THIS fetch is pending.
    expect(downloadBtn).toBeDisabled()

    await act(async () => {
      resolveDownload({ blobUrl: FAKE_BLOB_URL, revoke: vi.fn() })
      await Promise.resolve()
      await Promise.resolve()
    })

    // `setIsDownloading(false)` (line 58, `finally`) — re-enabled once settled.
    await waitFor(() => expect(downloadBtn).not.toBeDisabled())
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

  it('the <object> fallback text and the download link are separated by a real space (not run together)', async () => {
    mockFetch.mockResolvedValue({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
    renderPreview()
    const fallbackText = await screen.findByText(/Вбудований перегляд PDF недоступний/)
    // mutation-gate (@crm/web, Fix-round B, CI-MUT): the `{' '}` between the
    // sentence and the link -> `{""}` survived against the test above —
    // `getByText`'s regex normalizes/collapses whitespace, so it cannot see
    // a missing single space. `.textContent` on the shared parent is raw.
    expect(fallbackText.parentElement?.textContent).toBe(
      'Вбудований перегляд PDF недоступний. Завантажити контракт',
    )
  })
})

// mutation-gate (@crm/web, Fix-round B, CI-MUT) — `loadPdf`'s own
// isLoading/iframeLoading state transitions and its three abort/error-race
// guards had zero unit assertion beyond the terminal success/error states
// the tests above already cover.
describe('ContractPdfPreview — loading-state transitions and abort/error-race guards', () => {
  it('disables the refresh button and shows the overlay while the fetch is in flight, then re-enables it once resolved — but the overlay + invisible iframe persist until the iframe itself fires load', async () => {
    let resolveFetch!: (v: { blobUrl: string; revoke: () => void }) => void
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
    )

    renderPreview()

    // In flight: `setIsLoading(true)` (line 79) uniquely drives the refresh
    // button's own `disabled` — `iframeLoading` does not touch that button.
    expect(screen.getByTestId('contract-pdf-refresh-btn')).toBeDisabled()
    expect(screen.getByText('Завантаження PDF…')).toBeInTheDocument()

    await act(async () => {
      resolveFetch({ blobUrl: FAKE_BLOB_URL, revoke: mockRevoke })
      await Promise.resolve()
    })

    // `isLoading` is cleared in `loadPdf`'s `finally` once the fetch settles
    // — the refresh button re-enables...
    await waitFor(() => expect(screen.getByTestId('contract-pdf-refresh-btn')).not.toBeDisabled())
    // ...but `setIframeLoading(true)` (line 81) is a SEPARATE flag the
    // iframe's own `onLoad` clears, not the fetch settling — the overlay
    // (`isLoading || iframeLoading`) and the iframe's `invisible` class must
    // both still be present right here, BEFORE that `load` event fires.
    const iframe = screen.getByTitle('Попередній перегляд контракту')
    expect(screen.getByText('Завантаження PDF…')).toBeInTheDocument()
    expect(iframe.className).toContain('invisible')

    fireEvent.load(iframe)

    expect(screen.queryByText('Завантаження PDF…')).not.toBeInTheDocument()
    expect(iframe.className).not.toContain('invisible')
  })

  it('an AbortError from the fetch is swallowed silently — no toast, no error state (superseded/unmount race, not a real failure)', async () => {
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    })
    mockFetch.mockRejectedValue(abortError)

    renderPreview()

    // The generic-failure test elsewhere in this file proves a NON-AbortError
    // rejection DOES reach `contract-pdf-error` + a toast — this is the
    // contrasting case: same rejection SHAPE, only `.name` differs, and
    // NEITHER should fire.
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByTestId('contract-pdf-error')).not.toBeInTheDocument()
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('a fetch that resolves AFTER its own request was superseded (new userId) never calls setBlobUrl for the stale response', async () => {
    let resolveFirst!: (v: { blobUrl: string; revoke: () => void }) => void
    let callCount = 0
    mockFetch.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      }
      return new Promise(() => {
        /* second (superseding) fetch never resolves in this test */
      })
    })

    const { rerender } = render(
      <I18nTestProvider>
        <TooltipProvider>
          <ContractPdfPreview userId="user-1" isDirty={false} />
        </TooltipProvider>
      </I18nTestProvider>,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    // Supersede the first request (aborts its controller) BEFORE resolving it.
    rerender(
      <I18nTestProvider>
        <TooltipProvider>
          <ContractPdfPreview userId="user-2" isDirty={false} />
        </TooltipProvider>
      </I18nTestProvider>,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))

    // Stale response for the FIRST (now-aborted) request arrives late.
    await act(async () => {
      resolveFirst({ blobUrl: 'blob:http://localhost/stale-uuid', revoke: vi.fn() })
      await Promise.resolve()
    })

    // `if (controller.signal.aborted) return` (line 88) must have kept this
    // stale blob out of state — no iframe pointed at it ever appears.
    expect(screen.queryByTitle('Попередній перегляд контракту')).not.toBeInTheDocument()
  })

  it("a superseded request that REJECTS with a non-AbortError name (not just one that resolves) is still silently ignored, and never clears the SECOND (still in-flight) request's loading state", async () => {
    let rejectFirst!: (e: Error) => void
    let callCount = 0
    mockFetch.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return new Promise((_resolve, reject) => {
          rejectFirst = reject
        })
      }
      return new Promise(() => {
        /* second (still-loading) fetch never resolves in this test */
      })
    })

    const { rerender } = render(
      <I18nTestProvider>
        <TooltipProvider>
          <ContractPdfPreview userId="user-1" isDirty={false} />
        </TooltipProvider>
      </I18nTestProvider>,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    // Supersede — this both aborts the first controller AND starts the
    // second (still-pending) request, which sets `isLoading` true again.
    rerender(
      <I18nTestProvider>
        <TooltipProvider>
          <ContractPdfPreview userId="user-2" isDirty={false} />
        </TooltipProvider>
      </I18nTestProvider>,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('contract-pdf-refresh-btn')).toBeDisabled()

    // The FIRST request's underlying promise rejects LATE, with an error
    // that is NOT named 'AbortError' — line 93's name-check alone would NOT
    // catch this; only line 94's separate `controller.signal.aborted` check
    // (the controller IS aborted, from the supersede above) does.
    await act(async () => {
      rejectFirst(new Error('connection reset'))
      await Promise.resolve()
    })

    // Neither the stale error NOR its `finally` should surface: no error UI
    // for the first request, and (line 105) the SECOND request's own
    // `isLoading=true` must survive the FIRST request's `finally` — a
    // `!controller.signal.aborted` mutated to `controller.signal.aborted`
    // would let the (aborted) first controller's `finally` incorrectly
    // clear `isLoading` while the second fetch is still genuinely pending.
    expect(screen.queryByTestId('contract-pdf-error')).not.toBeInTheDocument()
    expect(mockToastError).not.toHaveBeenCalled()
    expect(screen.getByTestId('contract-pdf-refresh-btn')).toBeDisabled()
  })
})
