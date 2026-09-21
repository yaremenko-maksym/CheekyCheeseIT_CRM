/**
 * TosPdfPreview.test.tsx
 *
 * Unit tests for TosPdfPreview component.
 * Covers: root testid rendered, PDF iframe shown on success,
 * error state + generic toast on fetch failure, 429 throttle toast,
 * AbortController cleanup on unmount, refresh button.
 *
 * Note: TosPdfPreview debounces POST calls by 600 ms. We advance that
 * with vi.useFakeTimers() + vi.runAllTimersAsync() per test rather than
 * using waitFor's polling loop, because waitFor itself relies on
 * setTimeout internally and deadlocks when fake timers are active.
 */

import { render, screen, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { TosPdfPreview } from '../TosPdfPreview'

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('@/lib/axios', () => ({
  api: {
    post: vi.fn(),
  },
}))

vi.mock('@/lib/axios-utils', () => ({
  getAxiosStatus: vi.fn((err: unknown) => {
    if (err && typeof err === 'object' && 'response' in err) {
      return (err as { response?: { status?: number } }).response?.status ?? null
    }
    return null
  }),
}))

import { toast } from 'sonner'
import { api } from '@/lib/axios'

const FAKE_BLOB_URL = 'blob:http://localhost/fake-tos-pdf-uuid'
const FAKE_ARRAY_BUFFER = new ArrayBuffer(8)

const mockPost = api.post as ReturnType<typeof vi.fn>
const mockToastError = toast.error as ReturnType<typeof vi.fn>

const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(async () => {
  URL.createObjectURL = vi.fn().mockReturnValue(FAKE_BLOB_URL)
  URL.revokeObjectURL = vi.fn()
  mockPost.mockReset()
  mockToastError.mockReset()
  await loadCatalog('uk')
})

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SAMPLE_MARKDOWN = '# Terms of Service\n\nPlease read carefully.'

function renderPreview(bodyMarkdown = SAMPLE_MARKDOWN) {
  return render(<TosPdfPreview bodyMarkdown={bodyMarkdown} />, { wrapper: I18nTestProvider })
}

/**
 * Advance past the 600ms debounce and flush all resulting microtasks.
 * Must be called inside act() to flush React state updates.
 */
async function advanceDebounce() {
  vi.advanceTimersByTime(700)
  // Flush all pending microtasks (resolved promises) so component state updates
  await Promise.resolve()
  await Promise.resolve()
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TosPdfPreview', () => {
  it('renders the root testid container', () => {
    vi.useFakeTimers()
    mockPost.mockResolvedValue({ data: FAKE_ARRAY_BUFFER })
    renderPreview()
    expect(screen.getByTestId('tos-pdf-preview')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('renders the refresh button', () => {
    vi.useFakeTimers()
    mockPost.mockResolvedValue({ data: FAKE_ARRAY_BUFFER })
    renderPreview()
    expect(screen.getByTestId('tos-pdf-refresh-btn')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('renders the PDF viewer container', () => {
    vi.useFakeTimers()
    mockPost.mockResolvedValue({ data: FAKE_ARRAY_BUFFER })
    renderPreview()
    expect(screen.getByTestId('tos-pdf-viewer')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('shows PDF iframe after successful load (debounce resolved)', async () => {
    vi.useFakeTimers()
    mockPost.mockResolvedValue({ data: FAKE_ARRAY_BUFFER })

    renderPreview()

    await act(async () => {
      await advanceDebounce()
    })

    vi.useRealTimers()

    // Found by its accessible title (TosPdfPreview.tsx sets one) instead of
    // document.querySelector — task-lint-teeth.
    const iframe = screen.getByTitle('Попередній перегляд умов використання')
    expect(iframe).toBeInTheDocument()
    expect(iframe).toHaveAttribute('src', expect.stringContaining('blob:'))
    expect(mockToastError).not.toHaveBeenCalled()
    // MUT-1 (fix-round 2): the iframe's `aria-label` is a SEPARATE call site
    // from its `title` (both t`Попередній перегляд умов використання`) — the
    // title assertion above did not reach this one.
    expect(screen.getByLabelText('Попередній перегляд умов використання')).toBe(iframe)
  })

  // MUT-1 (fix-round 2): the POST call's URL, body, and `responseType` were
  // never individually pinned — any of the three could be mutated to
  // garbage and every existing test (which only checks the RESULT of a
  // successful mock) would still pass, since the mock resolves regardless
  // of what it was called with.
  it('POSTs the markdown body to /tos/preview-pdf with responseType arraybuffer', async () => {
    vi.useFakeTimers()
    mockPost.mockResolvedValue({ data: FAKE_ARRAY_BUFFER })

    renderPreview()

    await act(async () => {
      await advanceDebounce()
    })

    vi.useRealTimers()

    expect(mockPost).toHaveBeenCalledWith(
      '/tos/preview-pdf',
      { bodyMarkdown: SAMPLE_MARKDOWN },
      expect.objectContaining({ responseType: 'arraybuffer' }),
    )
  })

  // MUT-1 (fix-round 2): `URL.createObjectURL` is mocked to always return
  // the SAME fake URL regardless of its argument, so nothing observed the
  // Blob's actual CONSTRUCTION (its byte source or MIME type) before this
  // test — mutating either to empty changed nothing any assertion saw.
  it('builds the blob from the response bytes with the application/pdf MIME type', async () => {
    vi.useFakeTimers()
    mockPost.mockResolvedValue({ data: FAKE_ARRAY_BUFFER })
    const createObjectURLSpy = URL.createObjectURL as ReturnType<typeof vi.fn>

    renderPreview()

    await act(async () => {
      await advanceDebounce()
    })

    vi.useRealTimers()

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1)
    const blob = createObjectURLSpy.mock.calls[0]![0] as Blob
    expect(blob.type).toBe('application/pdf')
    // FAKE_ARRAY_BUFFER is 8 bytes — an empty `[]` Blob source would be 0.
    expect(blob.size).toBe(FAKE_ARRAY_BUFFER.byteLength)
  })

  it('shows error state and generic toast on non-429 fetch failure', async () => {
    vi.useFakeTimers()
    mockPost.mockRejectedValue(new Error('Network Error'))

    renderPreview()

    await act(async () => {
      await advanceDebounce()
    })

    vi.useRealTimers()

    expect(screen.getByTestId('tos-pdf-error')).toBeInTheDocument()
    expect(mockToastError).toHaveBeenCalledWith('Не вдалося завантажити PDF попереднього перегляду')
    // MUT-1 (fix-round 2): `setIframeLoading(false)` in the catch branch —
    // without it, the loading overlay would show ALONGSIDE the error block
    // (the two aren't mutually exclusive in the JSX: `isLoading ||
    // iframeLoading` vs a separate `hasError` block).
    expect(screen.queryByText('Завантаження PDF…')).not.toBeInTheDocument()
  })

  it('shows 429 throttle toast when fetch returns 429 response error', async () => {
    vi.useFakeTimers()
    const throttleError = Object.assign(new Error('Too Many Requests'), {
      response: { status: 429 },
    })
    mockPost.mockRejectedValue(throttleError)

    renderPreview()

    await act(async () => {
      await advanceDebounce()
    })

    vi.useRealTimers()

    expect(screen.getByTestId('tos-pdf-error')).toBeInTheDocument()
    expect(mockToastError).toHaveBeenCalledWith(
      'Забагато запитів поспіль. Зачекайте трохи і спробуйте ще раз',
    )
  })

  it('does NOT fire API call when bodyMarkdown is empty', () => {
    vi.useFakeTimers()
    renderPreview('')
    vi.advanceTimersByTime(700)
    expect(mockPost).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('refresh button click triggers a new PDF fetch (no debounce on explicit refresh)', async () => {
    vi.useFakeTimers()
    mockPost.mockResolvedValue({ data: FAKE_ARRAY_BUFFER })

    renderPreview()

    // Trigger initial debounced load
    await act(async () => {
      await advanceDebounce()
    })

    expect(mockPost).toHaveBeenCalledTimes(1)

    vi.useRealTimers()

    // Click refresh — direct loadPdf call, no debounce
    const user = userEvent.setup()
    await act(async () => {
      await user.click(screen.getByTestId('tos-pdf-refresh-btn'))
    })

    expect(mockPost).toHaveBeenCalledTimes(2)
  })

  // MUT-1 (fix-round 2): `revokeRef.current = revoke` (the closure wrapping
  // `URL.revokeObjectURL(url)`) was never actually INVOKED by any test — a
  // mutant turning it into a no-op survived, because nothing loaded a
  // SECOND pdf (the only path that calls the FIRST blob's own revoke
  // function, line 57's `revokeRef.current?.()`).
  it('revokes the PREVIOUS blob URL when a second load starts', async () => {
    vi.useFakeTimers()
    mockPost.mockResolvedValue({ data: FAKE_ARRAY_BUFFER })
    const revokeObjectURLSpy = URL.revokeObjectURL as ReturnType<typeof vi.fn>

    renderPreview()
    await act(async () => {
      await advanceDebounce()
    })
    expect(revokeObjectURLSpy).not.toHaveBeenCalled()
    vi.useRealTimers()

    const user = userEvent.setup()
    await act(async () => {
      await user.click(screen.getByTestId('tos-pdf-refresh-btn'))
    })

    expect(revokeObjectURLSpy).toHaveBeenCalledWith(FAKE_BLOB_URL)
  })

  // MUT-1 (fix-round 2): the two Error-name guards (`AbortError` /
  // `CanceledError`) that make an aborted/canceled request fail SILENTLY
  // (no error UI, no toast) were never exercised — every existing failure
  // test used a plain `Error`, which does NOT match either guard.
  it.each(['AbortError', 'CanceledError'])(
    'fails SILENTLY (no error state, no toast) when the request rejects with name=%s',
    async (errorName) => {
      vi.useFakeTimers()
      const abortLikeError = Object.assign(new Error('cancelled'), { name: errorName })
      mockPost.mockRejectedValue(abortLikeError)

      renderPreview()

      await act(async () => {
        await advanceDebounce()
      })

      vi.useRealTimers()

      expect(screen.queryByTestId('tos-pdf-error')).not.toBeInTheDocument()
      expect(mockToastError).not.toHaveBeenCalled()
    },
  )

  // MUT-1 (fix-round 2): `setHasError(false)` at the START of `loadPdf` (a
  // reset, distinct from the error-branch's OWN `setHasError(true)`) was
  // never observed — a retry after a failed load must clear the previous
  // error UI even before the new response comes back to confirm success.
  it('clears a previous error state as soon as a new load starts (before the new response even arrives)', async () => {
    vi.useFakeTimers()
    mockPost.mockRejectedValueOnce(new Error('Network Error'))

    renderPreview()
    await act(async () => {
      await advanceDebounce()
    })
    expect(screen.getByTestId('tos-pdf-error')).toBeInTheDocument()

    const retryButton = within(screen.getByTestId('tos-pdf-error')).getByRole('button', {
      name: 'Повторити',
    })

    // A DEFERRED (never-yet-resolved) promise for the retry — proves the
    // `setHasError(false)` reset at the TOP of `loadPdf` fires synchronously
    // on click, not merely as a side effect of the retry eventually
    // succeeding (which would mask a mutant that dropped the reset).
    let resolveRetry!: (v: { data: ArrayBuffer }) => void
    mockPost.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRetry = resolve
      }),
    )
    vi.useRealTimers()

    const user = userEvent.setup()
    await act(async () => {
      await user.click(retryButton)
    })

    expect(screen.queryByTestId('tos-pdf-error')).not.toBeInTheDocument()

    // Settle the retry so it doesn't leak into the next test.
    await act(async () => {
      resolveRetry({ data: FAKE_ARRAY_BUFFER })
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  // MUT-1 (fix-round 2): the loading overlay ("Завантаження PDF…") is shown
  // while EITHER `isLoading` or `iframeLoading` is true — no test ever
  // observed the MID-FLIGHT state (before the mocked promise resolves),
  // only before-start and after-resolve snapshots.
  it('shows the loading overlay while the request is in flight', async () => {
    vi.useFakeTimers()
    let resolvePost!: (v: { data: ArrayBuffer }) => void
    mockPost.mockReturnValue(
      new Promise((resolve) => {
        resolvePost = resolve
      }),
    )

    renderPreview()
    await act(async () => {
      vi.advanceTimersByTime(700)
    })

    expect(screen.getByText('Завантаження PDF…')).toBeInTheDocument()
    // MUT-1: `setIsLoading(true)` specifically — the refresh button's
    // `disabled={isLoading || !bodyMarkdown.trim()}` depends ONLY on
    // `isLoading`, not `iframeLoading` (which the overlay assertion above
    // cannot tell apart from `isLoading`, since the overlay shows on
    // EITHER being true).
    expect(screen.getByTestId('tos-pdf-refresh-btn')).toBeDisabled()

    await act(async () => {
      resolvePost({ data: FAKE_ARRAY_BUFFER })
      await Promise.resolve()
      await Promise.resolve()
    })
    vi.useRealTimers()

    // MUT-1: `setIframeLoading(true)` (start of loadPdf) only clears on the
    // <iframe>'s own `onLoad` — which jsdom never fires for a `blob:` src —
    // so the overlay correctly STAYS visible even after the fetch resolves.
    // A mutant that skipped setting `iframeLoading` true would make the
    // overlay disappear here instead (since `isLoading` alone already went
    // false in the `finally` block by this point).
    expect(screen.getByText('Завантаження PDF…')).toBeInTheDocument()
  })

  // MUT-1 (fix-round 2): the `[' ']` JSX-whitespace boundary between the
  // sentence and the download link, in the `<object>` fallback content
  // (rendered — in jsdom, unlike a real browser — as ordinary DOM children
  // of the `<iframe>`, since jsdom never actually loads iframe content).
  it('keeps a space between the fallback sentence and the download link', async () => {
    vi.useFakeTimers()
    mockPost.mockResolvedValue({ data: FAKE_ARRAY_BUFFER })

    renderPreview()
    await act(async () => {
      await advanceDebounce()
    })
    vi.useRealTimers()

    // Function matcher targets the OUTER <p> by its full concatenated text
    // — avoids DOM-navigation APIs (testing-library/no-node-access) while
    // pinning the `{' '}` boundary between the sentence and the link.
    const paragraph = screen.getByText(
      (_content, element) =>
        element?.tagName === 'P' &&
        element.textContent ===
          'Вбудований перегляд PDF недоступний. Завантажити умови використання',
    )
    expect(paragraph).toBeInTheDocument()
  })

  // MUT-1 (fix-round 2): `[i18n]` in `loadPdf`'s own `useCallback` deps —
  // mutated to `[]`, the callback would close over the FIRST render's
  // `i18n` instance forever. Only observable by switching locale AFTER
  // mount and confirming the error toast comes out in the NEW language.
  it('uses the CURRENT i18n instance after a locale switch (loadPdf useCallback dep)', async () => {
    vi.useFakeTimers()
    mockPost.mockRejectedValue(new Error('Network Error'))

    renderPreview()
    await loadCatalog('en')

    await act(async () => {
      await advanceDebounce()
    })
    vi.useRealTimers()

    expect(mockToastError).toHaveBeenCalledWith('Could not load the preview PDF')
  })

  // MUT-1 (fix-round 2): a real ABORT RACE — a SECOND load (refresh) fires
  // before the FIRST's response arrives, aborting the first's own
  // AbortController. When the first's (now-stale) response arrives late,
  // THREE guards must all fire to keep it from corrupting state that
  // belongs to the second, still-in-flight request:
  //   - line 70 `if (controller.signal.aborted) return` — skips building a
  //     blob from the stale response entirely (no second createObjectURL
  //     call from data that lost the race)
  //   - line 93 `if (!controller.signal.aborted) setIsLoading(false)` —
  //     the STALE controller's own `finally` must NOT clear `isLoading`,
  //     which would prematurely hide the loading overlay while the SECOND
  //     request is still genuinely pending
  // None of the above-mocked-resolved-immediately tests can distinguish
  // "guard present" from "guard removed", because they never let two
  // requests overlap.
  it('a stale (aborted) response arriving late does not corrupt the in-flight second request', async () => {
    vi.useFakeTimers()

    let resolveFirst!: (v: { data: ArrayBuffer }) => void
    mockPost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        }),
    )

    const { rerender } = renderPreview()
    await act(async () => {
      vi.advanceTimersByTime(700)
    })
    // First request now in flight (isLoading/iframeLoading true, overlay shown).
    expect(screen.getByText('Завантаження PDF…')).toBeInTheDocument()

    let resolveSecond!: (v: { data: ArrayBuffer }) => void
    mockPost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve
        }),
    )

    // A NEW `bodyMarkdown` re-triggers the debounced effect — a genuinely
    // overlapping second request while the first is still in flight (the
    // refresh BUTTON is `disabled` while `isLoading`, so it cannot be used
    // to construct this race).
    rerender(<TosPdfPreview bodyMarkdown={SAMPLE_MARKDOWN + ' v2'} />)
    await act(async () => {
      vi.advanceTimersByTime(700)
    })
    vi.useRealTimers()

    expect(mockPost).toHaveBeenCalledTimes(2)

    const createObjectURLSpy = URL.createObjectURL as ReturnType<typeof vi.fn>
    createObjectURLSpy.mockClear()

    // The STALE first response arrives late, AFTER it lost the race.
    await act(async () => {
      resolveFirst({ data: FAKE_ARRAY_BUFFER })
      await Promise.resolve()
      await Promise.resolve()
    })

    // Guards held: the stale response built NO blob, and did not clear
    // `isLoading` out from under the still-pending second request — checked
    // via the refresh button's OWN `disabled={isLoading || ...}`, not the
    // overlay (which also lights up on `iframeLoading` alone and so cannot
    // isolate `isLoading` specifically).
    expect(createObjectURLSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('tos-pdf-refresh-btn')).toBeDisabled()

    // Settle the second (real, winning) request so nothing leaks.
    await act(async () => {
      resolveSecond({ data: FAKE_ARRAY_BUFFER })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1)
  })

  // MUT-1 (fix-round 2): same race, but the STALE first response REJECTS
  // (a plain network error, not `AbortError`/`CanceledError` — those two
  // are already covered by name, this is `if (controller.signal.aborted)
  // return` inside the CATCH branch specifically, line 80's OWN guard,
  // unreachable by any resolve-path test above).
  it('a stale (aborted) response REJECTING late shows no error UI for the still-pending second request', async () => {
    vi.useFakeTimers()

    let rejectFirst!: (err: Error) => void
    mockPost.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject
        }),
    )

    const { rerender } = renderPreview()
    await act(async () => {
      vi.advanceTimersByTime(700)
    })

    let resolveSecond!: (v: { data: ArrayBuffer }) => void
    mockPost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve
        }),
    )
    rerender(<TosPdfPreview bodyMarkdown={SAMPLE_MARKDOWN + ' v3'} />)
    await act(async () => {
      vi.advanceTimersByTime(700)
    })
    vi.useRealTimers()

    // The STALE first request rejects late, AFTER losing the race.
    await act(async () => {
      rejectFirst(new Error('stale network error'))
      await Promise.resolve()
      await Promise.resolve()
    })

    // No error UI, no toast — the stale rejection was swallowed by the
    // aborted-signal guard, not surfaced as if it were the SECOND
    // request's own failure.
    expect(screen.queryByTestId('tos-pdf-error')).not.toBeInTheDocument()
    expect(mockToastError).not.toHaveBeenCalled()

    await act(async () => {
      resolveSecond({ data: FAKE_ARRAY_BUFFER })
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('AbortController: cleanup aborts the in-flight fetch on unmount', async () => {
    vi.useFakeTimers()

    let capturedSignal: AbortSignal | undefined

    mockPost.mockImplementation((_url: string, _body: unknown, opts?: { signal?: AbortSignal }) => {
      capturedSignal = opts?.signal
      return new Promise(() => {
        /* never resolves */
      })
    })

    const { unmount } = renderPreview()

    // Advance past debounce — fake timers active
    await act(async () => {
      await advanceDebounce()
    })

    vi.useRealTimers()

    expect(capturedSignal).toBeDefined()
    expect(capturedSignal!.aborted).toBe(false)

    unmount()

    expect(capturedSignal!.aborted).toBe(true)
  })
})
