/**
 * task-1316-fix1 item 3 — a worker that never replies (iOS kills it under
 * memory pressure) must not leave the preview pending forever, and must not
 * fall back to the full-size original (that is the freeze being fixed).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installFakePreviewWorker,
  pendingReplies,
  workerConstructions,
  workerStats,
} from '@/test/fake-preview-worker'
import { createImagePreviewUrl, PREVIEW_TIMEOUT_MS, revokeBlobUrl } from './image-preview'

const photo = new File([new Uint8Array(16)], 'IMG.jpg', { type: 'image/jpeg' })
const ORIGINAL = { fallback: 'original' } as const
const NONE = { fallback: 'none' } as const

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
    void createImagePreviewUrl(photo, 1024, ORIGINAL).then((r) => (result = r))

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
    const result = await createImagePreviewUrl(photo, 1024, ORIGINAL)
    expect(result).toBe('blob:bounded-preview')
    await vi.advanceTimersByTimeAsync(PREVIEW_TIMEOUT_MS)
    expect(workerStats.terminated).toBe(1)
  })
})

describe('createImagePreviewUrl — failure modes (task-1316-fix2 items 3, 5)', () => {
  it('5a: a reply that lands after the timeout does not create (and leak) a URL', async () => {
    vi.useFakeTimers()
    installFakePreviewWorker(photo, 'manual')
    const result = createImagePreviewUrl(photo, 1024, ORIGINAL)
    await vi.advanceTimersByTimeAsync(PREVIEW_TIMEOUT_MS)
    expect(await result).toBeNull()

    pendingReplies.splice(0).forEach((reply) => reply())

    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(workerStats.terminated).toBe(1)
  })

  it("5b: a worker 'error' reply resolves null, never the full-size original", async () => {
    installFakePreviewWorker(photo, 'error')
    expect(await createImagePreviewUrl(photo, 1024, ORIGINAL)).toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('5b: a worker crash (onerror) resolves null, never the full-size original', async () => {
    installFakePreviewWorker(photo, 'crash')
    expect(await createImagePreviewUrl(photo, 1024, ORIGINAL)).toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('3: new Worker() throwing does not reject — it falls back to the original (no usable worker)', async () => {
    installFakePreviewWorker(photo, 'throw')
    await expect(createImagePreviewUrl(photo, 1024, ORIGINAL)).resolves.toBe(
      'blob:original-full-size',
    )
  })
})

describe('createImagePreviewUrl — fallbacks and wiring (task-1316-fix3 A6, B1–B3)', () => {
  it('constructs the bundled module worker', async () => {
    installFakePreviewWorker(photo, 'auto')
    await createImagePreviewUrl(photo, 1024, NONE)
    expect(workerConstructions).toHaveLength(1)
    expect(workerConstructions[0]?.url).toMatch(/\/image-preview\.worker\.ts(\?|$)/)
    expect(workerConstructions[0]?.options).toEqual({ type: 'module' })
  })

  it("a `null` reply (already within maxEdge) resolves the original's URL", async () => {
    installFakePreviewWorker(photo, 'small')
    expect(await createImagePreviewUrl(photo, 1024, NONE)).toBe('blob:original-full-size')
  })

  it('a crash settles at once, not at the timeout', async () => {
    vi.useFakeTimers()
    installFakePreviewWorker(photo, 'crash')
    let result: string | null | undefined
    void createImagePreviewUrl(photo, 1024, ORIGINAL).then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBeNull()
    expect(workerStats.terminated).toBe(1)
  })

  // Each row strips exactly one thing; the rest is a working worker, so the
  // row passes only through the guard it names.
  it.each([
    ['no OffscreenCanvas', () => vi.stubGlobal('OffscreenCanvas', undefined)],
    ['no Worker', () => vi.stubGlobal('Worker', undefined)],
    ['a throwing Worker constructor', () => installFakePreviewWorker(photo, 'throw')],
  ])('B1: %s — `original` gets the file URL, `none` gets null', async (_label, strip) => {
    installFakePreviewWorker(photo, 'auto')
    strip()
    await expect(createImagePreviewUrl(photo, 1024, ORIGINAL)).resolves.toBe(
      'blob:original-full-size',
    )
    await expect(createImagePreviewUrl(photo, 1024, NONE)).resolves.toBeNull()
  })

  it.each([
    ['no OffscreenCanvas', () => vi.stubGlobal('OffscreenCanvas', undefined)],
    ['a throwing Worker constructor', () => installFakePreviewWorker(photo, 'throw')],
  ])(
    'fix4 item 2: %s and a throwing createObjectURL — `original` resolves null, never throws or rejects',
    async (_label, strip) => {
      installFakePreviewWorker(photo, 'auto')
      strip()
      vi.mocked(URL.createObjectURL).mockImplementation(() => {
        throw new Error('quota')
      })
      let result: Promise<string | null> | undefined
      expect(() => (result = createImagePreviewUrl(photo, 1024, ORIGINAL))).not.toThrow()
      await expect(result).resolves.toBeNull()
    },
  )

  it('fix4 item 3: an undeserializable reply (messageerror) settles at once with null', async () => {
    vi.useFakeTimers()
    installFakePreviewWorker(photo, 'messageError')
    let result: string | null | undefined
    void createImagePreviewUrl(photo, 1024, ORIGINAL).then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBeNull()
    expect(workerStats.terminated).toBe(1)
  })

  it('B1: without OffscreenCanvas no worker is started', async () => {
    installFakePreviewWorker(photo, 'auto')
    vi.stubGlobal('OffscreenCanvas', undefined)
    await createImagePreviewUrl(photo, 1024, NONE)
    expect(workerConstructions).toHaveLength(0)
  })

  it('B2: a synchronous postMessage throw (DataCloneError) resolves null, never rejects', async () => {
    installFakePreviewWorker(photo, 'cloneError')
    const result = createImagePreviewUrl(photo, 1024, ORIGINAL)
    // Settled at once by the catch, not 10 s later by the timeout.
    expect(workerStats.terminated).toBe(1)
    await expect(result).resolves.toBeNull()
  })

  it('B3: URL.createObjectURL throwing on the reply resolves null, never hangs', async () => {
    installFakePreviewWorker(photo, 'auto')
    vi.mocked(URL.createObjectURL).mockImplementation(() => {
      throw new Error('quota')
    })
    await expect(createImagePreviewUrl(photo, 1024, ORIGINAL)).resolves.toBeNull()
    expect(workerStats.terminated).toBe(1)
  })

  it('fix5 item 2: createObjectURL throwing on the worker reply blob resolves null, not a rejection', async () => {
    installFakePreviewWorker(photo, 'auto')
    const seen: Blob[] = []
    vi.mocked(URL.createObjectURL).mockImplementation((b) => {
      seen.push(b as Blob)
      throw new Error('quota')
    })

    await expect(createImagePreviewUrl(photo, 1024, ORIGINAL)).resolves.toBeNull()
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toBe(photo) // the worker's reply, not the original fallback
    expect(workerStats.terminated).toBe(1)
  })
})

describe('revokeBlobUrl', () => {
  it('revokes an object URL and leaves remote, data: and empty values alone', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    revokeBlobUrl('blob:http://x/1')
    revokeBlobUrl('https://cdn.example/blob:1')
    revokeBlobUrl('data:image/png;base64,AA')
    revokeBlobUrl(null)
    revokeBlobUrl(undefined)
    expect(revoke.mock.calls).toEqual([['blob:http://x/1']])
  })
})
