import { describe, expect, it } from 'vitest'
import {
  boundedNumber,
  boundedString,
  boundedStringArray,
  DATE_RAW_MAX_CHARS,
  dateRaw,
  optionalBoundedNumber,
  optionalString,
  optionalUrlString,
  positiveSafeInt,
  urlString,
} from './as'

/**
 * Expected values here are literals written from the helper's contract (a cap N accepts N and
 * refuses N + 1), never computed by the helper itself.
 */

describe('boundedString', () => {
  it('accepts a string of exactly the cap and returns it unchanged', () => {
    const s = 'a'.repeat(10)
    expect(boundedString(10).parse(s)).toBe(s)
  })
  it('refuses a string one past the cap', () => {
    expect(boundedString(10).safeParse('a'.repeat(11)).success).toBe(false)
  })
  it('refuses a non-string', () => {
    expect(boundedString(10).safeParse(5).success).toBe(false)
    expect(boundedString(10).safeParse(null).success).toBe(false)
  })
  it('accepts the empty string (emptiness is the observation builder verdict, not ours)', () => {
    expect(boundedString(10).parse('')).toBe('')
  })
})

describe('optionalString', () => {
  it('maps undefined and null to null', () => {
    expect(optionalString(5).parse(undefined)).toBeNull()
    expect(optionalString(5).parse(null)).toBeNull()
  })
  it('keeps a present string, at the cap', () => {
    expect(optionalString(5).parse('abcde')).toBe('abcde')
  })
  it('refuses one past the cap', () => {
    expect(optionalString(5).safeParse('abcdef').success).toBe(false)
  })
  it('refuses a non-string such as the boolean false Jobicy sends for a missing logo', () => {
    expect(optionalString(5).safeParse(false).success).toBe(false)
  })
})

describe('urlString / optionalUrlString', () => {
  const url = (n: number) => 'https://x.example/' + 'a'.repeat(n - 'https://x.example/'.length)
  it('accepts a link of exactly 2048 characters and refuses 2049', () => {
    expect(urlString().safeParse(url(2048)).success).toBe(true)
    expect(urlString().safeParse(url(2049)).success).toBe(false)
  })
  it('optional variant: 2048 ok, 2049 refused, absent -> null', () => {
    expect(optionalUrlString().parse(url(2048))).toBe(url(2048))
    expect(optionalUrlString().safeParse(url(2049)).success).toBe(false)
    expect(optionalUrlString().parse(undefined)).toBeNull()
    expect(optionalUrlString().parse(null)).toBeNull()
  })
})

describe('boundedNumber / optionalBoundedNumber', () => {
  it('accepts both bounds and refuses just outside them', () => {
    const n = boundedNumber(0, 10)
    expect(n.parse(0)).toBe(0)
    expect(n.parse(10)).toBe(10)
    expect(n.safeParse(-0.001).success).toBe(false)
    expect(n.safeParse(10.001).success).toBe(false)
  })
  it('refuses NaN, Infinity and numeric strings', () => {
    const n = boundedNumber(0, 10)
    expect(n.safeParse(Number.NaN).success).toBe(false)
    expect(n.safeParse(Number.POSITIVE_INFINITY).success).toBe(false)
    expect(n.safeParse('5').success).toBe(false)
  })
  it('optional variant maps absent to null and still enforces the bounds', () => {
    const n = optionalBoundedNumber(0, 10)
    expect(n.parse(undefined)).toBeNull()
    expect(n.parse(null)).toBeNull()
    expect(n.parse(10)).toBe(10)
    expect(n.safeParse(11).success).toBe(false)
  })
})

describe('positiveSafeInt', () => {
  it('accepts 1 and MAX_SAFE_INTEGER', () => {
    expect(positiveSafeInt().parse(1)).toBe(1)
    expect(positiveSafeInt().parse(9007199254740991)).toBe(9007199254740991)
  })
  it('refuses 0, a fraction and 2^53', () => {
    expect(positiveSafeInt().safeParse(0).success).toBe(false)
    expect(positiveSafeInt().safeParse(1.5).success).toBe(false)
    expect(positiveSafeInt().safeParse(9007199254740992).success).toBe(false)
  })
})

describe('dateRaw', () => {
  it('passes a Unix-seconds number and an ISO string through untouched', () => {
    expect(dateRaw().parse(1792673908)).toBe(1792673908)
    expect(dateRaw().parse('2026-10-22T12:58:28+00:00')).toBe('2026-10-22T12:58:28+00:00')
  })
  it('maps absent to null', () => {
    expect(dateRaw().parse(undefined)).toBeNull()
    expect(dateRaw().parse(null)).toBeNull()
  })
  it('caps the raw string at 64 characters: 64 ok, 65 refused', () => {
    expect(DATE_RAW_MAX_CHARS).toBe(64)
    expect(dateRaw().safeParse('2'.repeat(64)).success).toBe(true)
    expect(dateRaw().safeParse('2'.repeat(65)).success).toBe(false)
  })
  it('refuses a non-finite number', () => {
    expect(dateRaw().safeParse(Number.NaN).success).toBe(false)
    expect(dateRaw().safeParse(Number.POSITIVE_INFINITY).success).toBe(false)
  })
})

describe('boundedStringArray', () => {
  it('accepts exactly maxItems items and refuses one more', () => {
    const a = boundedStringArray(3, 4)
    expect(a.parse(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(a.safeParse(['a', 'b', 'c', 'd']).success).toBe(false)
  })
  it('accepts an item of maxChars and refuses one past it', () => {
    const a = boundedStringArray(3, 4)
    expect(a.parse(['abcd'])).toEqual(['abcd'])
    expect(a.safeParse(['abcde']).success).toBe(false)
  })
  it('refuses a non-string element', () => {
    expect(boundedStringArray(3, 4).safeParse(['a', 1]).success).toBe(false)
  })
})
