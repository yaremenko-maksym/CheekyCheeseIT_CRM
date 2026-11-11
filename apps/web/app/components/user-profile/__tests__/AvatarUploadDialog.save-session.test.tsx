/**
 * task-1316-fix4 item 4 — an avatar save belongs to the dialog session that
 * started it. Closing mid-upload (close is not blocked) and reopening must not
 * let the old upload revive the progress bar or close the reopened dialog.
 */
import { useEffect, useState } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { installFakePreviewWorker } from '@/test/fake-preview-worker'

const m = vi.hoisted(() => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  toastSuccess: vi.fn(),
}))
vi.mock('@/hooks/use-user-profile', () => ({
  useUpdateMe: () => ({ mutate: m.mutate, isPending: false }),
}))
vi.mock('@/hooks/use-documents', () => ({
  useUploadDocument: () => ({ mutateAsync: m.mutateAsync, isPending: false }),
}))
vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: vi.fn() } }))
vi.mock('../cropImage', () => ({
  getCroppedDataUrl: () => Promise.resolve('data:image/jpeg;base64,AAAA'),
}))
// happy-dom never loads the image, so the real cropper never reports an area.
vi.mock('react-easy-crop', () => ({
  default: ({ onCropComplete }: { onCropComplete: (a: unknown, p: unknown) => void }) => {
    useEffect(() => {
      onCropComplete({}, { x: 0, y: 0, width: 10, height: 10 })
    }, [onCropComplete])
    return null
  },
}))

import { AvatarUploadDialog } from '../AvatarUploadDialog'

const photo = new File([new Uint8Array(64)], 'IMG_0003.jpg', { type: 'image/jpeg' })

function Harness() {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button type="button" data-testid="reopen" onClick={() => setOpen(true)} />
      <AvatarUploadDialog
        open={open}
        onClose={() => setOpen(false)}
        userId="user-1"
        avatarDocumentId={null}
        avatarUrl={null}
      />
    </>
  )
}

let upload: { onProgress: (p: number) => void; finish: () => void; fail: () => void }

beforeEach(async () => {
  await loadCatalog('uk')
  installFakePreviewWorker(photo)
  m.mutate.mockReset()
  m.toastSuccess.mockReset()
  m.mutateAsync.mockReset().mockImplementation(
    ({ onProgress }: { onProgress: (p: number) => void }) =>
      new Promise((resolve, reject) => {
        upload = {
          onProgress,
          finish: () => resolve({ id: 'doc-1' }),
          fail: () => reject(new Error('net')),
        }
      }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)))

async function pickAndSave() {
  fireEvent.change(screen.getByTestId('avatar-file-input'), { target: { files: [photo] } })
  const save = await screen.findByRole('button', { name: 'Зберегти' })
  fireEvent.click(save)
  await vi.waitFor(() => expect(m.mutateAsync).toHaveBeenCalledTimes(1))
}

async function closeAndReopen() {
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByTestId('reopen'))
  await screen.findByRole('dialog')
}

describe('AvatarUploadDialog — save bound to its dialog session (task-1316-fix4 item 4)', () => {
  it('closing mid-upload: later progress from that upload does not bring the bar back', async () => {
    render(<Harness />, { wrapper: I18nTestProvider })
    await pickAndSave()
    await closeAndReopen()
    fireEvent.change(screen.getByTestId('avatar-file-input'), { target: { files: [photo] } })
    await screen.findByRole('button', { name: 'Зберегти' }) // crop step, where the bar lives

    await act(async () => {
      upload.onProgress(40)
      await nextFrame()
    })

    expect(screen.queryByTestId('avatar-upload-progress')).toBeNull()
  })

  it('closing mid-upload and reopening: the old save succeeding keeps the new dialog open, toast once', async () => {
    render(<Harness />, { wrapper: I18nTestProvider })
    await pickAndSave()
    await closeAndReopen()

    await act(async () => upload.finish())
    await vi.waitFor(() => expect(m.mutate).toHaveBeenCalledTimes(1))
    act(() => m.mutate.mock.calls[0]![1].onSuccess())

    expect(m.toastSuccess).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closing mid-upload and reopening: the old save failing sets no error on the new session', async () => {
    render(<Harness />, { wrapper: I18nTestProvider })
    await pickAndSave()
    await closeAndReopen()
    fireEvent.change(screen.getByTestId('avatar-file-input'), { target: { files: [photo] } })
    await screen.findByRole('button', { name: 'Зберегти' })

    await act(async () => upload.finish())
    await vi.waitFor(() => expect(m.mutate).toHaveBeenCalledTimes(1))
    act(() => m.mutate.mock.calls[0]![1].onError())

    expect(screen.queryByText('Не вдалося зберегти аватар')).toBeNull()
    expect(screen.getByRole('button', { name: 'Зберегти' })).toBeEnabled()
  })

  it('closing mid-upload and reopening: the old upload failing sets no error on the new session', async () => {
    render(<Harness />, { wrapper: I18nTestProvider })
    await pickAndSave()
    await closeAndReopen()
    fireEvent.change(screen.getByTestId('avatar-file-input'), { target: { files: [photo] } })
    await screen.findByRole('button', { name: 'Зберегти' })

    await act(async () => upload.fail())

    expect(screen.queryByText('Не вдалося обрізати зображення')).toBeNull()
    expect(screen.queryByTestId('avatar-upload-progress')).toBeNull()
  })

  it('the current session still finishes normally: success closes the dialog', async () => {
    render(<Harness />, { wrapper: I18nTestProvider })
    await pickAndSave()
    await act(async () => upload.finish())
    await vi.waitFor(() => expect(m.mutate).toHaveBeenCalledTimes(1))
    act(() => m.mutate.mock.calls[0]![1].onSuccess())

    expect(m.toastSuccess).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
