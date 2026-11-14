/**
 * Test double for `image-preview.worker.ts`: happy-dom has no Worker /
 * OffscreenCanvas. Every request is recorded and answered with a small JPEG
 * blob, the way the real worker answers a photo larger than `maxEdge`.
 *
 * Reply modes: `auto` answers on the next microtask; `manual` queues the
 * answer in `pendingReplies` so a test can hold a preview mid-decode;
 * `never` models a worker iOS killed under memory pressure; `error` is the
 * worker's own "decode failed" reply; `crash` fires `onerror`; `throw` makes
 * `new Worker(...)` itself throw (CSP, a missing chunk after a redeploy);
 * `small` is the "already within maxEdge" `null` reply; `cloneError` makes
 * `postMessage` throw synchronously (a DataCloneError); `messageError` fires
 * `onmessageerror` (a reply that could not be deserialized).
 */
import { vi } from 'vitest'
import type { PreviewRequest } from '@/lib/image-preview-size'

export type FakeReplyMode =
  | 'auto'
  | 'manual'
  | 'never'
  | 'error'
  | 'crash'
  | 'throw'
  | 'small'
  | 'cloneError'
  | 'messageError'

export const previewRequests: PreviewRequest[] = []
export const pendingReplies: Array<() => void> = []
export const workerStats = { terminated: 0 }
/** `new Worker(url, options)` arguments, one entry per constructed worker. */
export const workerConstructions: Array<{ url: string; options: unknown }> = []
let replyMode: FakeReplyMode = 'auto'

class FakePreviewWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  constructor(url: URL | string, options?: unknown) {
    if (replyMode === 'throw') throw new Error('worker blocked')
    workerConstructions.push({ url: String(url), options })
  }
  postMessage(req: PreviewRequest) {
    if (replyMode === 'cloneError') throw new DOMException('could not clone', 'DataCloneError')
    previewRequests.push(req)
    const reply = () => this.onmessage?.({ data: new Blob(['x'], { type: 'image/jpeg' }) })
    if (replyMode === 'auto') queueMicrotask(reply)
    else if (replyMode === 'manual') pendingReplies.push(reply)
    else if (replyMode === 'error') queueMicrotask(() => this.onmessage?.({ data: 'error' }))
    else if (replyMode === 'crash') queueMicrotask(() => this.onerror?.())
    else if (replyMode === 'messageError') queueMicrotask(() => this.onmessageerror?.())
    else if (replyMode === 'small') queueMicrotask(() => this.onmessage?.({ data: null }))
  }
  terminate() {
    workerStats.terminated += 1
  }
}

/** Installs the fake worker; `original` is the picked file, mapped to its own URL. */
export function installFakePreviewWorker(original: Blob, mode: FakeReplyMode = 'auto') {
  previewRequests.length = 0
  pendingReplies.length = 0
  workerStats.terminated = 0
  workerConstructions.length = 0
  replyMode = mode
  vi.stubGlobal('Worker', FakePreviewWorker)
  vi.stubGlobal('OffscreenCanvas', class {})
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) =>
    b === original ? 'blob:original-full-size' : 'blob:bounded-preview',
  )
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
}
