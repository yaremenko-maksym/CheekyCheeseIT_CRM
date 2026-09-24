import { describe, expect, it } from 'vitest'
import { formatBytes } from './format-bytes'

// task-i18n-stage3a (Task 2), Step 1 — `formatBytes` takes a required
// `locale` (uk/en units + decimal separator) instead of a hardcoded ru-RU
// format; see the plan's Task 2 Step 1/2 and format.ts's Global Constraints.
describe('formatBytes', () => {
  it('formats sub-KB values in bytes per locale', () => {
    expect(formatBytes(0, 'uk')).toBe('0 Б')
    expect(formatBytes(512, 'uk')).toBe('512 Б')
    expect(formatBytes(1023, 'uk')).toBe('1023 Б')
    expect(formatBytes(0, 'en')).toBe('0 B')
    expect(formatBytes(512, 'en')).toBe('512 B')
  })

  it('crosses to KB at 1024 with locale-appropriate decimal separator and unit', () => {
    expect(formatBytes(1024, 'uk')).toBe('1,0 КБ')
    expect(formatBytes(1536, 'uk')).toBe('1,5 КБ')
    expect(formatBytes(1024, 'en')).toBe('1.0 KB')
    expect(formatBytes(1536, 'en')).toBe('1.5 KB')
  })

  it('formats MB with locale-appropriate decimal separator', () => {
    expect(formatBytes(10 * 1024 * 1024, 'uk')).toBe('10,0 МБ')
    expect(formatBytes(2_345_678, 'uk')).toBe('2,2 МБ')
    expect(formatBytes(10 * 1024 * 1024, 'en')).toBe('10.0 MB')
    expect(formatBytes(2_345_678, 'en')).toBe('2.2 MB')
  })

  it('handles GB and TB without crashing', () => {
    expect(formatBytes(5 * 1024 ** 3, 'uk')).toMatch(/ГБ$/)
    expect(formatBytes(2 * 1024 ** 4, 'uk')).toMatch(/ТБ$/)
    expect(formatBytes(5 * 1024 ** 3, 'en')).toMatch(/GB$/)
    expect(formatBytes(2 * 1024 ** 4, 'en')).toMatch(/TB$/)
  })

  it('returns a zero-byte string for negative or invalid input, per locale', () => {
    expect(formatBytes(-1, 'uk')).toBe('0 Б')
    expect(formatBytes(Number.NaN, 'uk')).toBe('0 Б')
    expect(formatBytes(Number.POSITIVE_INFINITY, 'uk')).toBe('0 Б')
    expect(formatBytes(-1, 'en')).toBe('0 B')
  })
})
