import { describe, expect, it } from 'vitest'
import { canonicalizePostingUrl } from './job-source.provider'

describe('canonicalizePostingUrl', () => {
  it('strips every query param by default', () =>
    expect(canonicalizePostingUrl('https://a.test/j/1?utm=x&id=5')).toBe('https://a.test/j/1'))
  it('keeps listed params (sorted) — HN identifies items only by ?id=', () => {
    expect(canonicalizePostingUrl('https://news.ycombinator.com/item?utm=x&id=42', ['id'])).toBe(
      'https://news.ycombinator.com/item?id=42',
    )
    expect(canonicalizePostingUrl('https://a.test/j?b=2&a=1&c=3', ['b', 'a'])).toBe(
      'https://a.test/j?a=1&b=2',
    )
  })
  it('ignores listed params that are absent and encodes values', () => {
    expect(canonicalizePostingUrl('https://a.test/j/', ['id'])).toBe('https://a.test/j')
    expect(canonicalizePostingUrl('https://a.test/j?id=a%26b', ['id'])).toBe(
      'https://a.test/j?id=a%26b',
    )
  })
  it('keeps https-only, host lowercase, trailing slash and fragment stripping', () => {
    expect(canonicalizePostingUrl('http://a.test/j')).toBeNull()
    expect(canonicalizePostingUrl('javascript:alert(1)')).toBeNull()
    expect(canonicalizePostingUrl(null)).toBeNull()
    expect(canonicalizePostingUrl(' https://A.Test/J/#frag ')).toBe('https://a.test/J')
  })
})
