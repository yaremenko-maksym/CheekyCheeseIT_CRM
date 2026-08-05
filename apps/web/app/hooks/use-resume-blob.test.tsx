/**
 * use-resume-blob.ts — unit tests (task-candidate-card-resume AC2).
 *
 * Pins:
 * 1. Happy path: presigned URL -> fetch -> application/pdf -> blobUrl set.
 * 2. Unsupported format: fetch resolves but Content-Type isn't
 *    application/pdf -> isUnsupportedFormat=true, blobUrl stays null (the
 *    ACTUAL branch AC2's "unsupported format" test targets — there is no
 *    stored mimeType field, so this hook is the only place that decides it).
 * 3. Network/HTTP failure -> hasError=true.
 * 4. `open=false` never fetches (query stays disabled).
 * 5. Revokes the previous blob URL when the application/open state resets.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useApplicationResumeBlob } from './use-resume-blob'

const apiGet = vi.fn()
vi.mock('@/lib/axios', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}))

const FAKE_BLOB_URL = 'blob:http://localhost/fake-resume-uuid'
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
const fetchMock = vi.fn()

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  apiGet.mockReset()
  apiGet.mockResolvedValue({
    data: { url: 'https://r2.example/resume.pdf', expiresAt: '2026-01-01T00:10:00.000Z' },
  })
  URL.createObjectURL = vi.fn().mockReturnValue(FAKE_BLOB_URL)
  URL.revokeObjectURL = vi.fn()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
  vi.unstubAllGlobals()
})

describe('useApplicationResumeBlob', () => {
  it('happy path: application/pdf response -> blobUrl set, no error, not unsupported', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/pdf' },
      blob: async () => new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
    })

    const { result } = renderHook(() => useApplicationResumeBlob('vac-1', 'app-1', true), {
      wrapper,
    })

    await waitFor(() => expect(result.current.blobUrl).toBe(FAKE_BLOB_URL))
    expect(result.current.hasError).toBe(false)
    expect(result.current.isUnsupportedFormat).toBe(false)
    expect(fetchMock).toHaveBeenCalledWith('https://r2.example/resume.pdf', {
      signal: expect.any(AbortSignal),
      mode: 'cors',
    })
  })

  // AC2 — the actual "unsupported format" scenario: no stored mimeType field
  // exists for a vacancy-application resume, so this hook infers it from the
  // Content-Type header on the SAME fetch() response used to build the blob.
  it('non-PDF Content-Type -> isUnsupportedFormat=true, blobUrl stays null', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/msword' },
      arrayBuffer: async () => new ArrayBuffer(8),
    })

    const { result } = renderHook(() => useApplicationResumeBlob('vac-1', 'app-1', true), {
      wrapper,
    })

    await waitFor(() => expect(result.current.isUnsupportedFormat).toBe(true))
    expect(result.current.blobUrl).toBeNull()
    expect(result.current.hasError).toBe(false)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('missing Content-Type header -> treated as unsupported (not silently rendered as PDF)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(8),
    })

    const { result } = renderHook(() => useApplicationResumeBlob('vac-1', 'app-1', true), {
      wrapper,
    })

    await waitFor(() => expect(result.current.isUnsupportedFormat).toBe(true))
  })

  it('fetch HTTP error (e.g. expired presign) -> hasError=true', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 })

    const { result } = renderHook(() => useApplicationResumeBlob('vac-1', 'app-1', true), {
      wrapper,
    })

    await waitFor(() => expect(result.current.hasError).toBe(true))
    expect(result.current.blobUrl).toBeNull()
  })

  it('fetch network rejection -> hasError=true', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const { result } = renderHook(() => useApplicationResumeBlob('vac-1', 'app-1', true), {
      wrapper,
    })

    await waitFor(() => expect(result.current.hasError).toBe(true))
  })

  it('open=false never fetches the presigned URL or the blob', async () => {
    renderHook(() => useApplicationResumeBlob('vac-1', 'app-1', false), { wrapper })

    // Give any stray microtask a chance to run, then assert nothing fired.
    await act(async () => {
      await Promise.resolve()
    })
    expect(apiGet).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('revokes the previous blob URL when the dialog closes', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/pdf' },
      blob: async () => new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
    })

    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useApplicationResumeBlob('vac-1', 'app-1', open),
      { wrapper, initialProps: { open: true } },
    )

    await waitFor(() => expect(result.current.blobUrl).toBe(FAKE_BLOB_URL))

    rerender({ open: false })

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(FAKE_BLOB_URL)
    expect(result.current.blobUrl).toBeNull()
  })
})
