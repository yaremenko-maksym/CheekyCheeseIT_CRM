/**
 * Human-readable byte size formatter with Russian locale separators.
 *
 *   formatBytes(0)          // "0 Б"
 *   formatBytes(1023)       // "1023 Б"
 *   formatBytes(1024)       // "1,0 КБ"
 *   formatBytes(2_345_678)  // "2,2 МБ"
 *   formatBytes(10 * 1024 * 1024) // "10,0 МБ"
 *
 * Uses binary (1024) units to match how OS file managers and the API
 * `DOCUMENT_MAX_BYTES` (10 * 1024 * 1024) report sizes. ru-RU number
 * formatting renders the decimal separator as a comma.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 Б'
  if (bytes < 1024) return `${bytes} Б`

  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'] as const
  let value = bytes / 1024
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const rounded = Math.round(value * 10) / 10
  return `${rounded.toLocaleString('ru-RU', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} ${units[unitIndex]}`
}
