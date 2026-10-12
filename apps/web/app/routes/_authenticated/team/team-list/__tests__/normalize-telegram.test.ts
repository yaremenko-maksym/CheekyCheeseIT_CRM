import { describe, expect, it } from 'vitest'
import { normalizeTelegram } from '../normalize-telegram'

describe('normalizeTelegram', () => {
  it('prefixes a bare handle with @', () => {
    expect(normalizeTelegram('handle')).toBe('@handle')
  })

  it('keeps an existing leading @', () => {
    expect(normalizeTelegram('@handle')).toBe('@handle')
  })

  it('trims surrounding whitespace before deciding', () => {
    expect(normalizeTelegram('  handle ')).toBe('@handle')
    expect(normalizeTelegram('  @handle ')).toBe('@handle')
  })

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(normalizeTelegram('')).toBe('')
    expect(normalizeTelegram('   ')).toBe('')
  })

  it('only treats a leading @ as already normalized', () => {
    expect(normalizeTelegram('a@b')).toBe('@a@b')
  })
})
