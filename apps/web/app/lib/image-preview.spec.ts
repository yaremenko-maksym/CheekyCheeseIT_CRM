/**
 * task-1316-fix1 item 3 — a worker that never replies (iOS kills it under
 * memory pressure) must not leave the preview pending forever, and must not
 * fall back to the full-size original (that is the freeze being fixed).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFakePreviewWorker, pendingReplies, workerStats } from '@/test/fake-preview-worker'
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

describe('createImagePreviewUrl — failure modes (task-1316-fix2 items 3, 5)', () => {
  it('5a: a reply that lands after the timeout does not create (and leak) a URL', async () => {
    vi.useFakeTimers()
    installFakePreviewWorker(photo, 'manual')
    const result = createImagePreviewUrl(photo, 1024)
    await vi.advanceTimersByTimeAsync(PREVIEW_TIMEOUT_MS)
    expect(await result).toBeNull()

    pendingReplies.splice(0).forEach((reply) => reply())

    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(workerStats.terminated).toBe(1)
  })

  it("5b: a worker 'error' reply resolves null, never the full-size original", async () => {
    installFakePreviewWorker(photo, 'error')
    expect(await createImagePreviewUrl(photo, 1024)).toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('5b: a worker crash (onerror) resolves null, never the full-size original', async () => {
    installFakePreviewWorker(photo, 'crash')
    expect(await createImagePreviewUrl(photo, 1024)).toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('3: new Worker() throwing does not reject — it falls back to the original (no usable worker)', async () => {
    installFakePreviewWorker(photo, 'throw')
    await expect(createImagePreviewUrl(photo, 1024)).resolves.toBe('blob:original-full-size')
  })
})
