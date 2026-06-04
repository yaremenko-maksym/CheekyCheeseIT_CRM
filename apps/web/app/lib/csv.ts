/**
 * CSV utility helpers for client-side CSV generation.
 *
 * Security note: CSV injection mitigation (CWE-1236).
 * Spreadsheet applications (Excel, Google Sheets) may interpret cell values
 * starting with '=', '+', '-', '@', Tab, or CR as formulas.
 * We prefix such values with a single-quote (') which is the industry-standard
 * mitigation — the quote is visible in a text editor but treated as a
 * string-prefix indicator by spreadsheet apps, not rendered in the cell.
 */

/**
 * Escapes a single CSV cell value:
 *   1. CSV injection defense: prefix dangerous leading chars with single-quote.
 *   2. RFC 4180 quoting: wrap in double-quotes if value contains '"', ',', or newline;
 *      escape internal double-quotes by doubling them.
 */
export function csvEscape(value: string): string {
  let safe = value

  // Step 1 — CSV injection mitigation (prefix dangerous leading chars)
  if (/^[=+\-@\t\r]/.test(safe)) {
    safe = `'${safe}`
  }

  // Step 2 — RFC 4180 quoting
  if (safe.includes('"') || safe.includes(',') || safe.includes('\n')) {
    safe = `"${safe.replace(/"/g, '""')}"`
  }

  return safe
}
