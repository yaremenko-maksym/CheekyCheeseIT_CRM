/**
 * PR #1316 QA-M-1 — closing «Нова транзакція» while a receipt photo is still
 * being prepared must not upload it. The preview resolving during the close
 * animation used to start POST /documents and leave an unlinked RECEIPT
 * document (and its S3 object) behind.
 */
import { useState } from 'react'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { installFakePreviewWorker, pendingReplies } from '@/test/fake-preview-worker'

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN', displayName: 'Admin One' } }),
}))

const post = vi.fn()
vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: (...args: unknown[]) => post(...args),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { CreateTransactionDialog } from '../CreateTransactionDialog'

const photo = new File([new Uint8Array(1024)], 'IMG_0001.jpg', { type: 'image/jpeg' })

/** A real owner: «Скасувати» flips `open` to false, as the finance page does. */
function Owner() {
  const [open, setOpen] = useState(true)
  return <CreateTransactionDialog open={open} onClose={() => setOpen(false)} />
}

/**
 * happy-dom runs no CSS animations, so Radix Presence would unmount the content
 * the moment `open` turns false and the unmount alone would cancel the pick. On
 * a phone the content stays mounted for its exit animation: give the dialog
 * content a live `animationName` (never ending) so Presence holds it mounted.
 */
function holdExitAnimation() {
  const real = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    if (!(el instanceof HTMLElement) || el.dataset.testid !== 'create-transaction-dialog')
      return real(el, pseudo)
    const style = real(el, pseudo)
    return new Proxy(style, {
      get(target, prop) {
        if (prop === 'animationName')
          return el.getAttribute('data-state') === 'closed' ? 'exit' : 'enter'
        const value = Reflect.get(target, prop) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  })
}

beforeEach(async () => {
  await loadCatalog('uk')
  post.mockReset()
  post.mockReturnValue(new Promise(() => {}))
  installFakePreviewWorker(photo, 'manual')
  holdExitAnimation()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function closeMidPreview(close: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <Owner />
      </QueryClientProvider>
    </I18nTestProvider>,
  )
  fireEvent.change(await screen.findByTestId('receipt-input-file'), {
    target: { files: [photo] },
  })
  expect(pendingReplies).toHaveLength(1) // the preview is still decoding

  close()
  // Still animating out: the content (and ReceiptInput) is mounted.
  expect(screen.getByTestId('create-transaction-dialog')).toHaveAttribute('data-state', 'closed')
  await act(async () => {
    pendingReplies.splice(0).forEach((reply) => reply())
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('CreateTransactionDialog — closing mid-pick (QA-M-1)', () => {
  it('positive control: resolving the preview without closing uploads the document', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <I18nTestProvider>
        <QueryClientProvider client={qc}>
          <Owner />
        </QueryClientProvider>
      </I18nTestProvider>,
    )
    fireEvent.change(await screen.findByTestId('receipt-input-file'), {
      target: { files: [photo] },
    })
    expect(pendingReplies).toHaveLength(1) // the preview is still decoding

    await act(async () => {
      pendingReplies.splice(0).forEach((reply) => reply())
      await new Promise((r) => setTimeout(r, 0))
    })

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  })

  it('«Скасувати» while the preview decodes: the late preview never uploads', async () => {
    await closeMidPreview(() => fireEvent.click(screen.getByTestId('create-transaction-cancel')))
    expect(post).not.toHaveBeenCalled()
  })

  it('Escape (onOpenChange) while the preview decodes: the late preview never uploads', async () => {
    await closeMidPreview(() =>
      fireEvent.keyDown(screen.getByTestId('create-transaction-dialog'), { key: 'Escape' }),
    )
    expect(post).not.toHaveBeenCalled()
  })
})
