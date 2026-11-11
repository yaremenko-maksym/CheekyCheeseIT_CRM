/**
 * createImagePreviewUrl — an object URL for a bounded-size copy of a picked
 * image (task-ios-file-input-freeze).
 *
 * A phone photo is 12–48 MP. Handing the original file to an `<img>` (or a
 * cropper) makes the browser keep a full-resolution bitmap (48–190 MB) alive
 * for as long as the preview is on screen and re-composite it on every frame —
 * on iPhone Safari that stalls or kills the tab. Here the original is decoded
 * once, asynchronously (`createImageBitmap`), drawn into a canvas no larger
 * than `maxEdge` on its long side, and released straight away. Only the small
 * copy ever reaches the DOM. The caller still uploads the original file.
 *
 * Falls back to the original file's URL (the old behaviour) when the engine
 * has no `createImageBitmap`/canvas or cannot decode the format.
 * The caller owns the returned URL and must `URL.revokeObjectURL` it.
 */
export async function createImagePreviewUrl(file: Blob, maxEdge: number): Promise<string> {
  if (typeof createImageBitmap !== 'function') return URL.createObjectURL(file)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return URL.createObjectURL(file)
  }
  try {
    const scale = maxEdge / Math.max(bitmap.width, bitmap.height)
    if (scale >= 1) return URL.createObjectURL(file)
    const width = Math.round(bitmap.width * scale)
    const height = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return URL.createObjectURL(file)
    ctx.drawImage(bitmap, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9),
    )
    // iOS caps total canvas memory per page; zero the backing store now.
    canvas.width = 0
    canvas.height = 0
    return URL.createObjectURL(blob ?? file)
  } finally {
    bitmap.close()
  }
}
