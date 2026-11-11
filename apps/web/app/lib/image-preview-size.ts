/** Shared by `image-preview.ts` and its worker (task-ios-file-input-freeze). */
export interface PreviewRequest {
  file: Blob
  maxEdge: number
}

/** A bounded JPEG; `null` = already small, use the original; `'error'` = cannot decode. */
export type PreviewReply = Blob | null | 'error'

/** Size with the long edge at `maxEdge`, or `null` when the image already fits. */
export function boundedSize(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } | null {
  const scale = maxEdge / Math.max(width, height)
  if (scale >= 1) return null
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}
