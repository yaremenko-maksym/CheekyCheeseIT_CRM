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
  emitted.length = 0
  post.mockReturnValue(new Promise(() => {})) // upload stays in flight
  installFakePreviewWorker(photo)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Every state ReceiptInput emitted, in order — the last one is what the form keeps. */
const emitted: ReceiptState[] = []

function Harness({ explorerOnly = false }: { explorerOnly?: boolean }) {
  const [state, setState] = useState<ReceiptState>(emptyReceiptState())
  return (
    <>
      {/* The parent dialog resetting its receipt (e.g. PaySalaryDialog on reopen). */}
      <button
        type="button"
        data-testid="harness-reset"
        onClick={() => setState(emptyReceiptState())}
      />
      <ReceiptInput
        state={state}
        onChange={(next) => {
          emitted.push(next)
          setState(next)
        }}
        explorerOnly={explorerOnly}
      />
    </>
  )
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

describe('ReceiptInput — remaining races (task-1316-fix2)', () => {
  const pick = (file: File = photo) =>
    fireEvent.change(screen.getByTestId('receipt-input-file'), { target: { files: [file] } })

  /** An upload the test settles by hand. */
  function holdUpload() {
    let settle!: { ok: () => void; fail: () => void }
    post.mockReturnValue(
      new Promise((resolve, reject) => {
        settle = {
          ok: () =>
            resolve({
              data: { id: 'doc-1', name: 'IMG_0001.jpg', mimeType: 'image/jpeg' },
            }),
          fail: () => reject(new Error('network')),
        }
      }),
    )
    return () => settle
  }

  it.each([
    ['success', 'ok'],
    ['error', 'fail'],
  ] as const)(
    '1: an explorerOnly flip during the upload is not overwritten by its late %s',
    async (_label, outcome) => {
      const settle = holdUpload()
      const client = qc()
      const { rerender } = render(tree(false, client))
      pick()
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
      rerender(tree(true, client))
      expect(emitted.at(-1)?.mode).toBe('url')
      const before = emitted.length

      await act(async () => {
        settle()[outcome]()
        await Promise.resolve()
      })
      await new Promise((r) => setTimeout(r, 0))

      expect(emitted.length).toBe(before)
      expect(emitted.at(-1)?.mode).toBe('url')
    },
  )

  it('2: a cancel during the decode resets progress — the picker shows the idle prompt', async () => {
    installFakePreviewWorker(photo, 'manual')
    const client = qc()
    const { rerender } = render(tree(false, client))
    pick()
    rerender(tree(true, client))
    rerender(tree(false, client))
    fireEvent.click(screen.getByTestId('receipt-input-mode-file'))
    await finishDecodes()

    expect(screen.queryByTestId('receipt-input-progress-idle')).toBeNull()
    expect(screen.getByText('Натисніть, щоб вибрати файл')).toBeInTheDocument()
  })

  it('3: new Worker() throwing does not leave the picker disabled — the upload still runs', async () => {
    installFakePreviewWorker(photo, 'throw')
    renderHarness()
    pick()
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('receipt-input-file')).toBeDisabled() // upload in flight
    expect(emitted.at(-1)?.fileName).toBe('IMG_0001.jpg')
  })

  it('4: an untyped iOS image shows its preview; a broken preview falls back to the file name', async () => {
    const untyped = new File([new Uint8Array(8)], 'IMG_0004', { type: '' })
    installFakePreviewWorker(untyped)
    renderHarness()
    pick(untyped)

    const img = await screen.findByAltText('Прев’ю чека')
    expect(img).toHaveAttribute('src', 'blob:bounded-preview')

    fireEvent.error(img)
    expect(screen.queryByAltText('Прев’ю чека')).toBeNull()
    expect(screen.getByText('IMG_0004')).toBeInTheDocument()
  })
})

describe('ReceiptInput — pick lifecycle (task-1316-fix3 A1–A4, B1)', () => {
  const fileInput = () => screen.getByTestId('receipt-input-file')
  const pick = (file: File = photo) => fireEvent.change(fileInput(), { target: { files: [file] } })

  function holdUpload() {
    let settle!: { ok: () => void; fail: () => void }
    post.mockReturnValue(
      new Promise((resolve, reject) => {
        settle = {
          ok: () =>
            resolve({ data: { id: 'doc-1', name: 'IMG_0001.jpg', mimeType: 'image/jpeg' } }),
          fail: () => reject(new Error('network')),
        }
      }),
    )
    return () => settle
  }

  it('A1: a finished upload hands documentId to the form and re-enables the picker', async () => {
    const settle = holdUpload()
    renderHarness()
    expect(emitted).toEqual([]) // mounting in file mode emits nothing
    pick()
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(fileInput()).toBeDisabled()

    await act(async () => settle().ok())

    await waitFor(() => expect(emitted.at(-1)?.documentId).toBe('doc-1'))
    expect(emitted.at(-1)).toMatchObject({ mode: 'file', fileName: 'IMG_0001.jpg' })
    expect(fileInput()).toBeEnabled()
  })

  it('A1: a failed upload empties the state, shows the error and re-enables the picker', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const settle = holdUpload()
    renderHarness()
    pick()
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))

    await act(async () => settle().fail())

    await waitFor(() => expect(emitted.at(-1)).toEqual(emptyReceiptState()))
    expect(screen.getByTestId('receipt-input-progress-idle')).toBeInTheDocument()
    expect(fileInput()).toBeEnabled()
  })

  it('A2: cancel then re-pick gets a new token — the cancelled decode is never applied', async () => {
    installFakePreviewWorker(photo, 'manual')
    const client = qc()
    const { rerender } = render(tree(false, client))
    const a = new File([new Uint8Array(8)], 'IMG_A.jpg', { type: 'image/jpeg' })
    const b = new File([new Uint8Array(8)], 'IMG_B.jpg', { type: 'image/jpeg' })
    pick(a)
    rerender(tree(true, client)) // cancels A
    rerender(tree(false, client))
    fireEvent.click(screen.getByTestId('receipt-input-mode-file'))
    pick(b)
    expect(pendingReplies).toHaveLength(2)

    await act(async () => {
      pendingReplies[0]!() // A's decode lands after the cancel
      await Promise.resolve()
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(emitted.some((s) => s.fileName === 'IMG_A.jpg')).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })

  it('A2: one cancel between two picks still leaves the first pick stale (token only grows)', async () => {
    installFakePreviewWorker(photo, 'manual')
    const client = qc()
    const { rerender } = render(tree(false, client))
    const a = new File([new Uint8Array(8)], 'IMG_A.jpg', { type: 'image/jpeg' })
    const b = new File([new Uint8Array(8)], 'IMG_B.jpg', { type: 'image/jpeg' })
    pick(a)
    rerender(tree(true, client)) // the only cancel of A
    rerender(tree(false, client))
    fireEvent.click(screen.getByTestId('harness-reset')) // back to file mode, no cancel
    pick(b)
    expect(pendingReplies).toHaveLength(2)

    await act(async () => {
      pendingReplies[0]!()
      await Promise.resolve()
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(emitted.some((s) => s.fileName === 'IMG_A.jpg')).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })

  it('explorerOnly flipping on in url mode keeps the typed link', () => {
    const client = qc()
    const { rerender } = render(tree(false, client))
    fireEvent.click(screen.getByTestId('receipt-input-mode-url'))
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://etherscan.io/tx/0xabc' },
    })
    const before = emitted.length

    rerender(tree(true, client))

    expect(emitted.length).toBe(before)
    expect(emitted.at(-1)?.externalUrl).toBe('https://etherscan.io/tx/0xabc')
  })

  it('A3/A4: an unrelated rerender during the decode does not cancel the pick', async () => {
    installFakePreviewWorker(photo, 'manual')
    const client = qc()
    const { rerender } = render(tree(false, client))
    pick()
    rerender(tree(false, client))
    await finishDecodes()

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(emitted.at(-1)?.fileName).toBe('IMG_0001.jpg')
  })

  it('a PDF is not decoded and shows the document block, not an <img>', async () => {
    const pdf = new File([new Uint8Array(8)], 'act.pdf', { type: 'application/pdf' })
    renderHarness()
    pick(pdf)

    await screen.findByText('PDF-документ')
    expect(previewRequests).toEqual([])
    expect(screen.queryByAltText('Прев’ю чека')).toBeNull()
  })

  it.each([
    [
      'no OffscreenCanvas',
      () => {
        installFakePreviewWorker(photo, 'auto') // a working worker: only the guard yields null
        vi.stubGlobal('OffscreenCanvas', undefined)
      },
    ],
    ['a throwing Worker constructor', () => installFakePreviewWorker(photo, 'throw')],
  ])('B1: %s — no full-size thumbnail; the name shows and the upload runs', async (_l, strip) => {
    strip()
    renderHarness()
    pick()

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(URL.createObjectURL).not.toHaveBeenCalledWith(photo)
    expect(screen.queryByAltText('Прев’ю чека')).toBeNull()
    expect(screen.getByText('IMG_0001.jpg')).toBeInTheDocument()
  })
})

describe('ReceiptInput — stale upload progress (task-1316-fix3 B4)', () => {
  const pick = (file: File = photo) =>
    fireEvent.change(screen.getByTestId('receipt-input-file'), { target: { files: [file] } })

  /** The axios `onUploadProgress` the in-flight upload was started with. */
  const uploadProgress = () =>
    (post.mock.calls[0]![2] as { onUploadProgress: (e: { loaded: number; total: number }) => void })
      .onUploadProgress

  function holdUpload() {
    let finish!: () => void
    post.mockReturnValue(
      new Promise((resolve) => {
        finish = () =>
          resolve({ data: { id: 'doc-1', name: 'IMG_0001.jpg', mimeType: 'image/jpeg' } })
      }),
    )
    return () => finish()
  }

  it('B4: after an explorerOnly flip mid-upload, the stale upload’s progress does not bring the bar back', async () => {
    const finish = holdUpload()
    const client = qc()
    const { rerender } = render(tree(false, client))
    pick()
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    rerender(tree(true, client)) // cancels the pick: progress back to idle

    await act(async () => {
      uploadProgress()({ loaded: 40, total: 100 })
      uploadProgress()({ loaded: 100, total: 100 })
      await new Promise((r) => setTimeout(r, 50)) // past the rAF coalescing
      finish()
      await new Promise((r) => setTimeout(r, 0))
    })
    rerender(tree(false, client))
    // The parent puts the receipt back to an empty file pick: the picker shows.
    fireEvent.click(screen.getByTestId('harness-reset'))

    // `receipt-input-progress-idle` is the bar shown OUTSIDE the idle phase.
    expect(screen.queryByTestId('receipt-input-progress-idle')).toBeNull()
    expect(screen.getByText('Натисніть, щоб вибрати файл')).toBeInTheDocument()
  })

  it('B4: the current pick’s upload progress still reaches the bar', async () => {
    render(tree(false, qc()))
    pick()
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('receipt-input-progress')).not.toHaveTextContent('Обробка…')
    await act(async () => {
      uploadProgress()({ loaded: 100, total: 100 })
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(screen.getByTestId('receipt-input-progress')).toHaveTextContent('Обробка…')
  })
})

describe('ReceiptInput — a pick that settles after its dialog closed (PR #1316 QA step 3b)', () => {
  const fileInput = () => screen.getByTestId('receipt-input-file')
  const pick = (file: File = photo) => fireEvent.change(fileInput(), { target: { files: [file] } })
  // The dialog closing: its parent resets the receipt while the content is
  // still mounted for the exit animation (CreateTransactionDialog.resetForm).
  const closeDialog = () => fireEvent.click(screen.getByTestId('harness-reset'))
  const serverError = () =>
    Object.assign(new Error('Request failed with status code 500'), {
      isAxiosError: true,
      response: { status: 500, data: {} },
    })

  function holdUpload() {
    let settle!: { ok: () => void; fail: () => void }
    post.mockReturnValue(
      new Promise((resolve, reject) => {
        settle = {
          ok: () =>
            resolve({ data: { id: 'doc-1', name: 'IMG_0001.jpg', mimeType: 'image/jpeg' } }),
          fail: () => reject(serverError()),
        }
      }),
    )
    return () => settle
  }

  it('close mid-preview: the late preview is dropped, nothing uploads, the reopened form is empty', async () => {
    installFakePreviewWorker(photo, 'manual')
    renderHarness()
    pick()
    closeDialog()
    await finishDecodes()
    await new Promise((r) => setTimeout(r, 0))

    expect(emitted.some((s) => s.fileName === 'IMG_0001.jpg')).toBe(false)
    expect(post).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:bounded-preview')
    expect(screen.queryByAltText('Прев’ю чека')).toBeNull()
    expect(screen.getByText('Натисніть, щоб вибрати файл')).toBeInTheDocument()
  })

  it.each([
    ['success', 'ok'],
    ['500', 'fail'],
  ] as const)(
    'close mid-upload: its late %s does not write into the reset form',
    async (_l, outcome) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const settle = holdUpload()
      renderHarness()
      pick()
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
      closeDialog()
      const before = emitted.length

      await act(async () => {
        settle()[outcome]()
        await Promise.resolve()
      })
      await new Promise((r) => setTimeout(r, 0))

      expect(emitted.length).toBe(before)
      expect(screen.getByText('Натисніть, щоб вибрати файл')).toBeInTheDocument()
    },
  )

  it('a failed upload (500) never claims «Файл завантажено», even when its preview broke', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const settle = holdUpload()
    renderHarness()
    pick()
    // The blob URL got revoked under the card: it falls back to the file block.
    fireEvent.error(await screen.findByAltText('Прев’ю чека'))
    expect(screen.getByText('IMG_0001.jpg')).toBeInTheDocument()
    expect(screen.queryByText('Файл завантажено')).toBeNull()

    await act(async () => settle().fail())

    await waitFor(() =>
      expect(screen.getByTestId('receipt-input-progress-idle')).toBeInTheDocument(),
    )
    expect(screen.queryByText('Файл завантажено')).toBeNull()
    expect(emitted.at(-1)).toEqual(emptyReceiptState())
  })
})
