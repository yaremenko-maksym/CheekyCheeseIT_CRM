/**
 * Shared PDF generation utilities.
 *
 * `sha256Hex` — returns a 64-char hex SHA-256 of a Buffer.
 * `shortHash` — returns the first 8 chars (display only).
 * `loadFontBuffer` — loads a TTF from `src/assets/fonts/` with a process-level
 *   cache (Map) so the disk read only occurs once per process.
 *
 * These were previously duplicated between `invoice-pdf.utils.ts` (hash fns)
 * and `invoice-pdf.service.ts` (font loading). Moving them here lets
 * InvoicePdfService and future ContractPdfService share the implementations.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolveAssetPath } from '../assets.util'

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 of `buffer` as a 64-char lowercase hex string.
 *
 * Used as the `pdf_hash` column in `invoice_signatures` and as the
 * tamper-detection value compared on the COUNTERPARTY click-sign path.
 */
export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * First 8 chars of a full 64-char SHA-256 hex string.
 *
 * Used for display next to the signer's name in both the PDF itself and
 * the public /verify response. 8 hex chars (32 bits) is sufficient for
 * a human cross-check while keeping the full hash server-side.
 *
 * Throws on malformed input so callers cannot accidentally feed in a
 * truncated or wrong-format value.
 */
export function shortHash(fullHash: string): string {
  if (!/^[0-9a-f]{64}$/i.test(fullHash)) {
    throw new Error(
      `shortHash: expected 64-char hex SHA-256, got "${fullHash.slice(0, 16)}..." (length ${fullHash.length})`,
    )
  }
  return fullHash.slice(0, 8).toLowerCase()
}

// ---------------------------------------------------------------------------
// Font cache + loader
// ---------------------------------------------------------------------------

/**
 * Process-level font cache. Loading a ~300 KB TTF from disk on every
 * PDF request would be wasteful — Map.get() is < 1 µs vs ~50 ms for a
 * cold disk read. The cache is intentionally per-process (not per-request)
 * because font bytes never change between requests.
 */
const fontCache = new Map<string, Buffer>()

/**
 * Load a TTF font file from `src/assets/fonts/<fontFileName>`.
 *
 * Resolution strategy:
 *   1. Check `dist/assets/fonts/` — used in production (`node dist/main`)
 *   2. Fall back to `src/assets/fonts/` — used in Vitest / `tsx` runs
 *
 * The `nest-cli.json` `assets` glob mirrors `src/assets/` → `dist/assets/`
 * so both paths point to the same physical file; we try dist first to avoid
 * a stat() on a guaranteed-absent path during production.
 *
 * Results are cached in `fontCache` to avoid repeated disk I/O.
 */
export function loadFontBuffer(fontFileName: string): Buffer {
  const cached = fontCache.get(fontFileName)
  if (cached) return cached

  // dist-first / src-fallback resolution now lives in ONE place, because the
  // Typst renderer needs the identical rule for its template and font path.
  const fontPath = resolveAssetPath(`fonts/${fontFileName}`)
  const buffer = readFileSync(fontPath)
  fontCache.set(fontFileName, buffer)
  return buffer
}

/**
 * Clear the font cache. Exposed for testing only — allows unit tests to
 * verify cache-miss behaviour without cross-test state pollution.
 *
 * @internal
 */
export function _clearFontCacheForTesting(): void {
  fontCache.clear()
}
