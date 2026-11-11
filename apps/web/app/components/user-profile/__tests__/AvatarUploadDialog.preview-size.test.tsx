/**
 * task-ios-file-input-freeze — regression: the avatar cropper must receive a
 * bounded-size copy of the picked photo. The old code read the whole file with
 * `FileReader.readAsDataURL` and fed the multi-megabyte base64 string straight
 * into the cropper, so a full-resolution phone photo was decoded and kept on
 * screen (and redrawn on every pan/zoom) at full size.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@/hooks/use-user-profile', () => ({
  useUpdateMe: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/use-documents', () => ({
  useUploadDocument: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { AvatarUploadDialog } from '../AvatarUploadDialog'

const photo = new File([new Uint8Array(2048)], 'IMG_0002.jpg', { type: 'image/jpeg' })
const drawImage = vi.fn()

beforeEach(async () => {
  await loadCatalog('uk')
  drawImage.mockClear()
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockResolvedValue({ width: 3000, height: 4000, close: vi.fn() }),
  )
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) =>
    b === photo ? 'blob:original-full-size' : 'blob:bounded-preview',
  )
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
  )
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new Blob(['x'], { type: 'image/jpeg' }))
  }
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
    // Portrait 3000×4000 → long edge bounded to 2048 px.
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1536, 2048)
  })
})
