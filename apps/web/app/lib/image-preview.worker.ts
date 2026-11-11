/**
 * Decodes and downscales a picked photo off the main thread for
 * `createImagePreviewUrl` (task-ios-file-input-freeze). Replies with the
 * bounded JPEG (PNG for a PNG source), `null` when the image is already small enough, or `'error'`.
 */
import { boundedSize, type PreviewRequest, type PreviewReply } from './image-preview-size'

self.onmessage = async (e: MessageEvent<PreviewRequest>) => {
  let reply: PreviewReply
  try {
    const bitmap = await createImageBitmap(e.data.file, { imageOrientation: 'from-image' })
    const size = boundedSize(bitmap.width, bitmap.height, e.data.maxEdge)
    if (!size) {
      bitmap.close()
      reply = null
    } else {
      const canvas = new OffscreenCanvas(size.width, size.height)
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, size.width, size.height)
      bitmap.close()
      // PNG stays PNG: the avatar crop is cut from this copy, and JPEG would turn
      // a transparent background black.
      const type = e.data.file.type === 'image/png' ? 'image/png' : 'image/jpeg'
      reply = await canvas.convertToBlob({ type, quality: 0.9 })
    }
  } catch {
    reply = 'error'
  }
  self.postMessage(reply)
}
