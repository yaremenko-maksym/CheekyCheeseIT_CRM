import { describe, expect, it } from 'vitest'
import { stripUnstorableChars } from './strip-unstorable'

describe('stripUnstorableChars', () => {
  it('removes NUL', () => expect(stripUnstorableChars('a\u0000b')).toBe('ab'))
  it('removes C0 controls except newline and tab', () =>
    expect(stripUnstorableChars('a\u0001\u0008b\nc\td\u001Fe')).toBe('ab\nc\tde'))
  it('removes C1 controls', () => expect(stripUnstorableChars('a\u0080\u009Fb')).toBe('ab'))
  it('removes DEL', () => expect(stripUnstorableChars('a\u007Fb')).toBe('ab'))
  it('keeps ordinary and non-ASCII text', () =>
    expect(stripUnstorableChars('Привіт, café 日本')).toBe('Привіт, café 日本'))
})

describe('stripUnstorableChars bidi/zero-width/surrogates', () => {
  it('removes zero-width and bidi controls', () =>
    expect(stripUnstorableChars('a\u200Bb\u200Ec\u202Ed\u2066e\u2069f\uFEFFg\u2060h\u061Ci')).toBe(
      'abcdefghi',
    ))
  it('drops lone surrogates but keeps valid pairs', () => {
    expect(stripUnstorableChars('a\uD800b\uDC00c')).toBe('abc')
    expect(stripUnstorableChars('a😀b')).toBe('a😀b')
  })
})
