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
 * Falls back to the original file's URL (the old behaviour) only when there is
 * no usable worker: the engine has no `Worker` / `OffscreenCanvas` (Safari
 * < 16.4), or `new Worker(...)` throws (CSP, a missing chunk after a redeploy).
 * Resolves `null` (no preview) when the worker cannot decode the file (its
 * `'error'` reply), crashes (`onerror`), or does not answer within
 * `PREVIEW_TIMEOUT_MS` — iOS may kill it under memory pressure, and handing
 * the original file to an `<img>` there would bring the freeze back.
 * Never rejects; settles once — a late reply after the timeout is ignored.
 * The caller owns the returned URL and must `URL.revokeObjectURL` it.
 */
import type { PreviewReply, PreviewRequest } from './image-preview-size'

export const PREVIEW_TIMEOUT_MS = 10_000

export function createImagePreviewUrl(file: Blob, maxEdge: number): Promise<string | null> {
  const original = () => URL.createObjectURL(file)
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return Promise.resolve(original())
  }
  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./image-preview.worker.ts', import.meta.url), {
        type: 'module',
      })
    } catch {
      resolve(original())
      return
    }
    let settled = false
    const done = (url: () => string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      resolve(url())
    }
    const timer = setTimeout(() => done(() => null), PREVIEW_TIMEOUT_MS)
    worker.onmessage = (e: MessageEvent<PreviewReply>) =>
      done(() => {
        if (e.data instanceof Blob) return URL.createObjectURL(e.data)
        // `null`: already within maxEdge, the original is safe to show.
        return e.data === null ? original() : null
      })
    worker.onerror = () => done(() => null)
    const request: PreviewRequest = { file, maxEdge }
    worker.postMessage(request)
  })
}
