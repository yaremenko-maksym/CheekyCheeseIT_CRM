/**
 * Hash helpers for the invoice signing flow.
 *
 * `sha256Hex` returns the canonical 64-char hex digest of a Buffer — used as
 * the `pdf_hash` column in `invoice_signatures` and as the tamper-detection
 * cookie compared on the COUNTERPARTY click-sign path.
 *
 * `shortHash` extracts the first 8 chars for display next to the signer's
 * name in both the PDF itself and the public /verify response. Eight hex
 * chars (32 bits) is enough for a human cross-check while keeping the
 * full hash server-side only.
 */
import { createHash } from 'crypto'

/** SHA-256 of `buffer` as a 64-char lowercase hex string. */
export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * First 8 chars of a 64-char SHA-256 hex string. Used for display only —
 * never relied on for security. Throws on malformed input so callers can't
 * accidentally feed in a truncated or wrong-format value.
 */
export function shortHash(fullHash: string): string {
  if (!/^[0-9a-f]{64}$/i.test(fullHash)) {
    throw new Error(
      `shortHash: expected 64-char hex SHA-256, got "${fullHash.slice(0, 16)}..." (length ${fullHash.length})`,
    )
  }
  return fullHash.slice(0, 8).toLowerCase()
}
