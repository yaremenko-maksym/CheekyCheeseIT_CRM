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

import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
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

beforeEach(() => {
  URL.createObjectURL = vi.fn().mockReturnValue(FAKE_BLOB_URL)
  URL.revokeObjectURL = vi.fn()
  mockPost.mockReset()
  mockToastError.mockReset()
})

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SAMPLE_MARKDOWN = '# Terms of Service\n\nPlease read carefully.'

function renderPreview(bodyMarkdown = SAMPLE_MARKDOWN) {
  return render(<TosPdfPreview bodyMarkdown={bodyMarkdown} />)
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
    const iframe = screen.getByTitle('Предпросмотр Terms of Service')
    expect(iframe).toBeInTheDocument()
    expect(iframe).toHaveAttribute('src', expect.stringContaining('blob:'))
    expect(mockToastError).not.toHaveBeenCalled()
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
    expect(mockToastError).toHaveBeenCalledWith('Не удалось загрузить PDF предпросмотра.')
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
    expect(mockToastError).toHaveBeenCalledWith('Слишком часто. Подождите минуту.')
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
