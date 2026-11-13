/** True when an S3 / R2 SDK error means the object (or key) does not exist. */
export function isS3NotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  )
}

/**
 * True only for a missing object on GetObject (`NoSuchKey`, in `name` or `Code`).
 * Narrower than `isS3NotFound`: a missing bucket is HTTP 404 too and must surface
 * as a server fault, not as "document not found". HEAD has no body to tell the two
 * apart, so HEAD callers keep `isS3NotFound`.
 */
export function isS3NoSuchKey(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: string; Code?: string }
  return candidate.name === 'NoSuchKey' || candidate.Code === 'NoSuchKey'
}
