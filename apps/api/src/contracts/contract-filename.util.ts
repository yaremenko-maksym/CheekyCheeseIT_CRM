import type { EmployeeContractStatus } from '@crm/shared'

/**
 * Builds a safe Content-Disposition filename for contract PDFs.
 *
 * Security: interpolating raw displayName into Content-Disposition headers can
 * break the header (quotes, newlines) or corrupt the filename on some browsers.
 * We produce two forms per RFC 5987:
 *   - `filename="<ascii-safe>"` — 7-bit fallback for old clients.
 *   - `filename*=UTF-8''<percent-encoded>` — full Unicode for RFC 5987 clients.
 *
 * @param displayName  Raw user display name (may contain non-ASCII, quotes, newlines).
 * @param status       Current contract status — determines the filename prefix.
 */
export function safeContractFilename(
  displayName: string,
  status: EmployeeContractStatus | string,
): { asciiName: string; contentDisposition: string } {
  const prefix = status === 'SIGNED' ? 'contract' : 'contract-preview'

  // Build a Unicode-safe slug from the name:
  // 1. Trim whitespace.
  // 2. Replace runs of whitespace with a single hyphen.
  // 3. Strip characters outside [A-Za-z0-9._-] for the ASCII fallback
  //    (non-Latin chars are removed; they survive in the RFC 5987 form).
  const trimmed = displayName.trim()
  const slugged = trimmed.replace(/\s+/g, '-')
  const asciiSlug = slugged.replace(/[^A-Za-z0-9._-]/g, '')
  const safePart = asciiSlug || 'employee'

  const asciiName = `${prefix}-${safePart}.pdf`

  // RFC 5987 filename* with UTF-8 percent-encoding of the original Unicode slug.
  // encodeURIComponent percent-encodes all non-ASCII + unsafe ASCII chars.
  const utf8Encoded = encodeURIComponent(`${prefix}-${slugged || 'employee'}.pdf`)
  const contentDisposition = `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Encoded}`

  return { asciiName, contentDisposition }
}
