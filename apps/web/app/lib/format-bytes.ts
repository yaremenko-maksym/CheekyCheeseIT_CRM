import { formatNumber, type Locale } from '@crm/shared'

/**
 * Human-readable byte size formatter, locale-aware (uk/en units + decimal
 * separator).
 *
 * task-i18n-stage3a (Task 2), Step 2 — was hardcoded ru-RU (`toLocaleString`)
 * with Cyrillic unit abbreviations; now takes a required `locale` and routes
 * the number through `formatNumber` (`@crm/shared`) so the decimal separator
 * follows the active locale like every other formatted number in the app.
 *
 *   formatBytes(0, 'uk')          // "0 Б"
 *   formatBytes(1023, 'uk')       // "1023 Б"
 *   formatBytes(1024, 'uk')       // "1,0 КБ"
 *   formatBytes(2_345_678, 'en')  // "2.2 MB"
 *   formatBytes(10 * 1024 * 1024, 'en') // "10.0 MB"
 *
 * Uses binary (1024) units to match how OS file managers and the API
 * `DOCUMENT_MAX_BYTES` (10 * 1024 * 1024) report sizes.
 */
const UNITS: Record<Locale, readonly string[]> = {
  uk: ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'],
  en: ['B', 'KB', 'MB', 'GB', 'TB'],
}

export function formatBytes(bytes: number, locale: Locale): string {
  const units = UNITS[locale]
  // Stryker disable next-line EqualityOperator: bytes===0 is equivalent under
  // < and <=, both fall through to the next branch and return "0 <unit>" —
  // no assertion can distinguish `bytes < 0` from `bytes <= 0` here.
  if (!Number.isFinite(bytes) || bytes < 0) return `0 ${units[0]}`
  if (bytes < 1024) return `${bytes} ${units[0]}`

  let value = bytes / 1024
  let unitIndex = 1

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const rounded = Math.round(value * 10) / 10
  return `${formatNumber(rounded, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${units[unitIndex]}`
}
