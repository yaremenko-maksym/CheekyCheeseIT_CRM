/**
 * task-ios-file-input-freeze — regression: the avatar cropper must receive a
 * bounded-size copy of the picked photo. The old code read the whole file with
 * `FileReader.readAsDataURL` and fed the multi-megabyte base64 string straight
 * into the cropper, so a full-resolution phone photo was decoded and kept on
 * screen (and redrawn on every pan/zoom) at full size.
 */
import { render, screen, fireEvent, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import {
  installFakePreviewWorker,
  pendingReplies,
  previewRequests,
} from '@/test/fake-preview-worker'

vi.mock('@/hooks/use-user-profile', () => ({
  useUpdateMe: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/use-documents', () => ({
  useUploadDocument: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { AvatarUploadDialog } from '../AvatarUploadDialog'

const photo = new File([new Uint8Array(2048)], 'IMG_0002.jpg', { type: 'image/jpeg' })

beforeEach(async () => {
  await loadCatalog('uk')
  installFakePreviewWorker(photo)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AvatarUploadDialog — bounded crop source (iOS freeze regression)', () => {
  it('hands the cropper a downscaled copy of a 3000×4000 photo, not the full file', async () => {
    render(
      <AvatarUploadDialog
        open={true}
        onClose={() => {}}
        userId="user-1"
        avatarDocumentId={null}
        avatarUrl={null}
      />,
      { wrapper: I18nTestProvider },
    )
    fireEvent.change(screen.getByTestId('avatar-file-input'), { target: { files: [photo] } })

    const cropImg = await screen.findByRole('presentation')
    expect(cropImg).toHaveAttribute('src', 'blob:bounded-preview')
    expect(previewRequests).toEqual([{ file: photo, maxEdge: 2048 }])
  })
})

describe('AvatarUploadDialog — stale preview after close (task-1316-fix1 item 2)', () => {
  const dialog = (open: boolean) => (
    <AvatarUploadDialog
      open={open}
      onClose={() => {}}
      userId="user-1"
      avatarDocumentId={null}
      avatarUrl={null}
    />
  )

  it('closing while the photo decodes drops it: reopening shows the source step, URL revoked', async () => {
    installFakePreviewWorker(photo, 'manual')
    const { rerender } = render(dialog(true), { wrapper: I18nTestProvider })
    fireEvent.change(screen.getByTestId('avatar-file-input'), { target: { files: [photo] } })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    rerender(dialog(false))

    await act(async () => {
      pendingReplies.splice(0).forEach((reply) => reply())
      await Promise.resolve()
    })
    rerender(dialog(true))

    expect(screen.queryByRole('presentation')).toBeNull()
    expect(screen.getByTestId('avatar-file-input')).toBeInTheDocument()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:bounded-preview')
  })

  it('a preview timeout shows the read error instead of the crop step', async () => {
    installFakePreviewWorker(photo, 'never')
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(dialog(true), { wrapper: I18nTestProvider })
      fireEvent.change(screen.getByTestId('avatar-file-input'), { target: { files: [photo] } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(await screen.findByText('Не вдалося прочитати файл')).toBeInTheDocument()
      expect(screen.queryByRole('presentation')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
