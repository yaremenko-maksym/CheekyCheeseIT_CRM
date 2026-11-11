/**
 * task-1316-fix1 item 3 — a worker that never replies (iOS kills it under
 * memory pressure) must not leave the preview pending forever, and must not
 * fall back to the full-size original (that is the freeze being fixed).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFakePreviewWorker, workerStats } from '@/test/fake-preview-worker'
import { createImagePreviewUrl, PREVIEW_TIMEOUT_MS } from './image-preview'

const photo = new File([new Uint8Array(16)], 'IMG.jpg', { type: 'image/jpeg' })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createImagePreviewUrl — worker timeout', () => {
  it('resolves null and terminates the worker when it never answers', async () => {
    vi.useFakeTimers()
    installFakePreviewWorker(photo, 'never')
    let result: string | null | undefined
    void createImagePreviewUrl(photo, 1024).then((r) => (result = r))

    await vi.advanceTimersByTimeAsync(PREVIEW_TIMEOUT_MS - 1)
    expect(result).toBeUndefined()
    expect(workerStats.terminated).toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBeNull()
    expect(workerStats.terminated).toBe(1)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('a reply before the deadline wins and the timer does not fire later', async () => {
    vi.useFakeTimers()
    installFakePreviewWorker(photo, 'auto')
    const result = await createImagePreviewUrl(photo, 1024)
    expect(result).toBe('blob:bounded-preview')
    await vi.advanceTimersByTimeAsync(PREVIEW_TIMEOUT_MS)
    expect(workerStats.terminated).toBe(1)
  })
})
