/// <reference lib="webworker" />
/**
 * Decodes and downscales a picked photo off the main thread for
 * `createImagePreviewUrl` (task-ios-file-input-freeze). Replies with the
 * bounded JPEG, `null` when the image is already small enough, or `'error'`.
 */
import { boundedSize, type PreviewRequest, type PreviewReply } from './image-preview-size'

self.onmessage = async (e: MessageEvent<PreviewRequest>) => {
  let reply: PreviewReply
  try {
    const bitmap = await createImageBitmap(e.data.file)
    const size = boundedSize(bitmap.width, bitmap.height, e.data.maxEdge)
    if (!size) {
      bitmap.close()
      reply = null
    } else {
      const canvas = new OffscreenCanvas(size.width, size.height)
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, size.width, size.height)
      bitmap.close()
      reply = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
    }
  } catch {
    reply = 'error'
  }
  self.postMessage(reply)
}
