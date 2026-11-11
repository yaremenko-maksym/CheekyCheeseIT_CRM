/**
 * Test double for `image-preview.worker.ts`: happy-dom has no Worker /
 * OffscreenCanvas. Every request is recorded and answered with a small JPEG
 * blob, the way the real worker answers a photo larger than `maxEdge`.
 */
import { vi } from 'vitest'
import type { PreviewRequest } from '@/lib/image-preview-size'

export const previewRequests: PreviewRequest[] = []

class FakePreviewWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  postMessage(req: PreviewRequest) {
    previewRequests.push(req)
    queueMicrotask(() => this.onmessage?.({ data: new Blob(['x'], { type: 'image/jpeg' }) }))
  }
  terminate() {}
}

/** Installs the fake worker; `original` is the picked file, mapped to its own URL. */
export function installFakePreviewWorker(original: Blob) {
  previewRequests.length = 0
  vi.stubGlobal('Worker', FakePreviewWorker)
  vi.stubGlobal('OffscreenCanvas', class {})
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) =>
    b === original ? 'blob:original-full-size' : 'blob:bounded-preview',
  )
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
}
