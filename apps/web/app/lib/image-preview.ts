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
 * Falls back to the original file's URL (the old behaviour) when the engine
 * has no worker `OffscreenCanvas` (Safari < 16.4) or cannot decode the format.
 * The caller owns the returned URL and must `URL.revokeObjectURL` it.
 */
import type { PreviewReply, PreviewRequest } from './image-preview-size'

export function createImagePreviewUrl(file: Blob, maxEdge: number): Promise<string> {
  const original = () => URL.createObjectURL(file)
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return Promise.resolve(original())
  }
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./image-preview.worker.ts', import.meta.url), {
      type: 'module',
    })
    const done = (url: string) => {
      worker.terminate()
      resolve(url)
    }
    worker.onmessage = (e: MessageEvent<PreviewReply>) =>
      done(e.data instanceof Blob ? URL.createObjectURL(e.data) : original())
    worker.onerror = () => done(original())
    const request: PreviewRequest = { file, maxEdge }
    worker.postMessage(request)
  })
}
