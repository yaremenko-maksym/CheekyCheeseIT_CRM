import { describe, expect, it } from 'vitest'
import { formatBytes } from './format-bytes'

describe('formatBytes', () => {
  it('formats sub-KB values in bytes', () => {
    expect(formatBytes(0)).toBe('0 Б')
    expect(formatBytes(512)).toBe('512 Б')
    expect(formatBytes(1023)).toBe('1023 Б')
  })

  it('crosses to KB at 1024', () => {
    expect(formatBytes(1024)).toBe('1,0 КБ')
    expect(formatBytes(1536)).toBe('1,5 КБ')
  })

  it('formats MB with ru-RU comma decimal', () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe('10,0 МБ')
    expect(formatBytes(2_345_678)).toMatch(/МБ$/)
  })

  it('handles GB and TB without crashing', () => {
    expect(formatBytes(5 * 1024 ** 3)).toMatch(/ГБ$/)
    expect(formatBytes(2 * 1024 ** 4)).toMatch(/ТБ$/)
  })

  it('returns "0 Б" for negative or invalid input', () => {
    expect(formatBytes(-1)).toBe('0 Б')
    expect(formatBytes(Number.NaN)).toBe('0 Б')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 Б')
  })
})
