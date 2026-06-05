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
import { ContractPdfPreview } from '../ContractPdfPreview'

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

beforeEach(() => {
  URL.createObjectURL = vi.fn().mockReturnValue(FAKE_BLOB_URL)
  URL.revokeObjectURL = vi.fn()
  mockRevoke.mockReset()
  mockToastError.mockReset()
  mockFetch.mockReset()
})

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderPreview(isDirty = false, userId = 'user-uuid') {
  return render(
    <TooltipProvider>
      <ContractPdfPreview userId={userId} isDirty={isDirty} />
    </TooltipProvider>,
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
      const iframe = document.querySelector('iframe')
      expect(iframe).toBeInTheDocument()
      expect(iframe?.src).toContain('blob:')
    })

    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('shows error state and generic toast on non-429 fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network Error'))

    renderPreview()

    await waitFor(() => {
      expect(screen.getByTestId('contract-pdf-error')).toBeInTheDocument()
    })

    expect(mockToastError).toHaveBeenCalledWith('Не удалось загрузить PDF предпросмотра.')
  })

  it('shows 429 throttle toast when fetch returns 429 response error', async () => {
    const throttleError = Object.assign(new Error('Too Many Requests'), {
      response: { status: 429 },
    })
    mockFetch.mockRejectedValue(throttleError)

    renderPreview()

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Слишком часто. Подождите минуту.')
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
      <TooltipProvider>
        <ContractPdfPreview userId="user-1" isDirty={false} />
      </TooltipProvider>,
    )

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(firstSignal?.aborted).toBe(false)

    // Change userId — triggers new fetch, old controller should be aborted
    rerender(
      <TooltipProvider>
        <ContractPdfPreview userId="user-2" isDirty={false} />
      </TooltipProvider>,
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
      expect(mockToastError).toHaveBeenCalledWith('Не удалось скачать PDF.')
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
      expect(mockToastError).toHaveBeenCalledWith('Слишком часто. Подождите минуту.')
    })
  })
})
