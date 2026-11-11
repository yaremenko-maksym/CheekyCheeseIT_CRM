/**
 * task-ios-file-input-freeze — regression: a picked phone photo must never be
 * handed to the DOM at full resolution. The old code previewed the receipt via
 * `URL.createObjectURL(file)` of the ORIGINAL file, so a 12–24 MP iPhone photo
 * was decoded and composited at full size inside the dialog. The fix previews
 * a bounded-size copy; the upload still sends the original file.
 */
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import {
  installFakePreviewWorker,
  pendingReplies,
  previewRequests,
} from '@/test/fake-preview-worker'

const post = vi.fn()
vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: { url: 'https://cdn.example.com/receipt.png' } }),
    post: (...args: unknown[]) => post(...args),
  },
}))

import { ReceiptInput, emptyReceiptState, type ReceiptState } from '../ReceiptInput'

const photo = new File([new Uint8Array(1024)], 'IMG_0001.jpg', { type: 'image/jpeg' })

beforeEach(async () => {
  await loadCatalog('uk')
  post.mockReset()
  post.mockReturnValue(new Promise(() => {})) // upload stays in flight
  installFakePreviewWorker(photo)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function Harness({ explorerOnly = false }: { explorerOnly?: boolean }) {
  const [state, setState] = useState<ReceiptState>(emptyReceiptState())
  return <ReceiptInput state={state} onChange={setState} explorerOnly={explorerOnly} />
}

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

function tree(explorerOnly: boolean, client: QueryClient) {
  return (
    <I18nTestProvider>
      <QueryClientProvider client={client}>
        <Harness explorerOnly={explorerOnly} />
      </QueryClientProvider>
    </I18nTestProvider>
  )
}

function renderHarness() {
  return render(tree(false, qc()))
}

/** Resolves every preview held mid-decode by the `manual` fake worker. */
async function finishDecodes() {
  await act(async () => {
    pendingReplies.splice(0).forEach((reply) => reply())
    await Promise.resolve()
  })
}

describe('ReceiptInput — bounded image preview (iOS freeze regression)', () => {
  it('previews a 4000×3000 photo through a downscaled copy, never the original file', async () => {
    renderHarness()
    fireEvent.change(screen.getByTestId('receipt-input-file'), { target: { files: [photo] } })

    const img = await screen.findByAltText('Прев’ю чека')
    expect(img).toHaveAttribute('src', 'blob:bounded-preview')
    expect(previewRequests).toEqual([{ file: photo, maxEdge: 1024 }])
  })

  it('still uploads the ORIGINAL file, not the preview copy', async () => {
    renderHarness()
    fireEvent.change(screen.getByTestId('receipt-input-file'), { target: { files: [photo] } })

    await waitFor(() => expect(post).toHaveBeenCalled())
    const form = post.mock.calls[0]![1] as FormData
    const sent = form.get('file') as File
    expect(sent.name).toBe('IMG_0001.jpg')
    expect(sent.size).toBe(1024)
  })
})

describe('ReceiptInput — async preview races (task-1316-fix1 item 1)', () => {
  const pick = (file: File = photo) =>
    fireEvent.change(screen.getByTestId('receipt-input-file'), { target: { files: [file] } })

  it('1a: a second pick while the first preview decodes uploads once — the stale one is revoked', async () => {
    installFakePreviewWorker(photo, 'manual')
    renderHarness()
    pick()
    pick()
    expect(pendingReplies).toHaveLength(2)

    await finishDecodes()

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:bounded-preview')
  })

  it('1a: the picker is disabled while the preview decodes', async () => {
    installFakePreviewWorker(photo, 'manual')
    renderHarness()
    pick()
    expect(screen.getByTestId('receipt-input-file')).toBeDisabled()
    expect(screen.getByTestId('receipt-input-mode-url')).toBeDisabled()
    await finishDecodes()
  })

  it('1b: an explorerOnly flip during the decode wins — no upload, no file state', async () => {
    installFakePreviewWorker(photo, 'manual')
    const client = qc()
    const { rerender } = render(tree(false, client))
    pick()
    rerender(tree(true, client))

    await finishDecodes()

    expect(post).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:bounded-preview')
    expect(screen.queryByAltText('Прев’ю чека')).toBeNull()
    expect(screen.getByPlaceholderText('https://etherscan.io/tx/0x...')).toBeInTheDocument()
  })

  it('1b/1c: unmount during the decode — no upload, the preview URL is revoked', async () => {
    installFakePreviewWorker(photo, 'manual')
    const { unmount } = renderHarness()
    pick()
    unmount()

    await finishDecodes()

    expect(post).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:bounded-preview')
  })

  it('item 5: a file with an empty type (iOS Files) still goes through the bounded preview', async () => {
    const untyped = new File([new Uint8Array(8)], 'IMG_0003.HEIC', { type: '' })
    installFakePreviewWorker(untyped)
    renderHarness()
    pick(untyped)
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(previewRequests).toEqual([{ file: untyped, maxEdge: 1024 }])
  })

  it('item 3: a preview timeout still uploads and shows the file name', async () => {
    installFakePreviewWorker(photo, 'never')
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderHarness()
      pick()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
      expect(screen.getByText('IMG_0001.jpg')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
