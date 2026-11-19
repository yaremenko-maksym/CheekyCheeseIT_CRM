/**
 * createImagePreviewUrl — an object URL for a bounded-size copy of a picked
 * image (task-ios-file-input-freeze).
 *
 * A phone photo is 12–48 MP. Handing the original file to an `<img>` (or a
 * cropper, worse: as a multi-megabyte `data:` URL) keeps a full-resolution
 * bitmap (48–190 MB) alive while the preview is on screen — on iPhone Safari
 * that stalls or kills the tab. Here the photo is decoded and downscaled in a
 * worker (`createImageBitmap` + `OffscreenCanvas`): measured in WebKit, a
 * main-thread `createImageBitmap` of a 4000×3000 JPEG blocks the main thread
 * ~150 ms and an `<img>.decode()` + canvas `drawImage` ~80 ms, the worker ~9 ms.
 * Only the small copy reaches the DOM; the caller still uploads the original.
 *
 * When there is no usable worker — no `OffscreenCanvas` (Safari < 16.4), no
 * `Worker`, or `new Worker(...)` throws (CSP, a missing chunk after a
 * redeploy) — the caller's `fallback` decides: `'original'` resolves the
 * original file's URL (the old behaviour; the avatar cropper needs a source),
 * `'none'` resolves `null` (the receipt shows its file name instead).
 * Resolves `null` (no preview) when the worker cannot decode the file (its
 * `'error'` reply), crashes (`onerror`), cannot be posted to, or does not
 * answer within `PREVIEW_TIMEOUT_MS` — iOS may kill it under memory pressure,
 * and handing the original file to an `<img>` there would bring the freeze back.
 * Never rejects; settles once — a late reply after the timeout is ignored.
 * The caller owns the returned URL and must release it with `revokeBlobUrl`.
 */
import type { PreviewReply, PreviewRequest } from './image-preview-size'

export const PREVIEW_TIMEOUT_MS = 10_000

export type PreviewFallback = 'original' | 'none'

/** Revokes an object URL; a remote / `data:` URL or an empty value is left alone. */
export function revokeBlobUrl(url: string | null | undefined): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
}

export function createImagePreviewUrl(
  file: Blob,
  maxEdge: number,
  { fallback }: { fallback: PreviewFallback },
): Promise<string | null> {
  const original = () => URL.createObjectURL(file)
  // Never throws: createObjectURL can fail (out of memory), and this runs both
  // outside the promise and inside its executor.
  const noWorker = () => {
    if (fallback !== 'original') return null
    try {
      return original()
    } catch {
      return null
    }
  }
  // No `Worker` needs no check of its own: `new Worker` throws into the catch below.
  if (typeof OffscreenCanvas === 'undefined') return Promise.resolve(noWorker())
  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./image-preview.worker.ts', import.meta.url), {
        type: 'module',
      })
    } catch {
      resolve(noWorker())
      return
    }
    let settled = false
    const done = (url: () => string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      let result: string | null = null
      try {
        result = url()
      } catch {
        // URL.createObjectURL failed (out of memory): no preview.
      }
      resolve(result)
    }
    const timer = setTimeout(() => done(() => null), PREVIEW_TIMEOUT_MS)
    worker.onmessage = (e: MessageEvent<PreviewReply>) =>
      done(() => {
        if (e.data instanceof Blob) return URL.createObjectURL(e.data)
        // `null`: already within maxEdge, the original is safe to show.
        return e.data === null ? original() : null
      })
    worker.onerror = () => done(() => null)
    worker.onmessageerror = () => done(() => null) // a reply that could not be deserialized
    const request: PreviewRequest = { file, maxEdge }
    try {
      worker.postMessage(request)
    } catch {
      done(() => null) // DataCloneError
    }
  })
}
