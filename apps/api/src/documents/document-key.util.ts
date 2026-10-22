/**
 * Pure helpers that build the ASCII-safe pieces of a document's S3 object key.
 *
 * Extracted VERBATIM from `DocumentsService` (behavior-preserving move). The
 * key layout itself (`documents/<category>/<ownerId>/<docId>-<name>`) is still
 * assembled inline in the service; only the two string transforms live here.
 * No I/O, no storage client, no access decisions — a pure function of its input.
 */

/**
 * Replace any character that's not alphanumeric / dot / dash / underscore,
 * cap the result at 200 chars. We collapse spaces to underscores so URLs
 * stay clean.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned.slice(0, 200) || 'file'
}

/** Thumbnail key: <key-without-ext>-thumb.jpg */
export function thumbnailKeyFor(key: string): string {
  return key.replace(/\.[^.]+$/, '') + '-thumb.jpg'
}
