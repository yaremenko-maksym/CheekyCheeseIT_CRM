import { describe, expect, it } from 'vitest'
import { checkStoredLink } from './url-policy'

const reasonOf = (raw: string | null | undefined) => {
  const r = checkStoredLink(raw)
  return r.ok ? 'ACCEPTED' : r.reason
}

describe('checkStoredLink: rejections (each has a nearby accepted control)', () => {
  it('rejects userinfo, accepts the same URL without it', () => {
    expect(reasonOf('https://user:pw@jobs.example/j/1')).toBe('USERINFO')
    expect(reasonOf('https://user@jobs.example/j/1')).toBe('USERINFO')
    expect(reasonOf('https://jobs.example/j/1')).toBe('ACCEPTED')
  })

  it('rejects non-https schemes, accepts https', () => {
    for (const bad of [
      'http://jobs.example/j',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'file:///etc/passwd',
      'ftp://jobs.example/j',
    ]) {
      expect(reasonOf(bad), bad).toBe('UNSAFE_SCHEME')
    }
    expect(reasonOf('https://jobs.example/j')).toBe('ACCEPTED')
  })

  it('rejects non-default ports; an explicit :443 is the default and is accepted', () => {
    expect(reasonOf('https://jobs.example:8443/j')).toBe('UNSAFE_PORT')
    expect(reasonOf('https://jobs.example:22/j')).toBe('UNSAFE_PORT')
    expect(reasonOf('https://jobs.example:443/j')).toBe('ACCEPTED')
  })

  it('rejects IP literals in every spelling the URL parser folds to an address', () => {
    for (const bad of [
      'https://127.0.0.1/j',
      'https://8.8.8.8/j',
      'https://2130706433/j', // decimal form of 127.0.0.1
      'https://0x7f.0.0.1/j', // hex octet
      'https://[::1]/j',
      'https://[::ffff:7f00:1]/j', // v4-mapped v6
    ]) {
      expect(reasonOf(bad), bad).toBe('IP_LITERAL')
    }
    // A hostname that merely starts with digits is a name, not an address.
    expect(reasonOf('https://123abc.example/j')).toBe('ACCEPTED')
  })

  it('rejects unparseable, empty, nullish and oversized input', () => {
    expect(reasonOf('not a url')).toBe('UNPARSEABLE')
    expect(reasonOf('')).toBe('UNPARSEABLE')
    expect(reasonOf(null)).toBe('UNPARSEABLE')
    expect(reasonOf(undefined)).toBe('UNPARSEABLE')
    expect(reasonOf(`https://jobs.example/${'a'.repeat(2040)}`)).toBe('TOO_LONG')
    expect(reasonOf(`https://jobs.example/${'a'.repeat(2000)}`)).toBe('ACCEPTED')
  })
})

describe('checkStoredLink: host normalization', () => {
  const hostOf = (raw: string) => {
    const r = checkStoredLink(raw)
    return r.ok ? r.url.hostname : null
  }

  it('maps a Unicode IDN, its punycode form, case variants and a trailing dot to ONE host', () => {
    const forms = [
      'https://bücher.example/j',
      'https://xn--bcher-kva.example/j',
      'https://BÜCHER.Example/j',
      'https://bücher.example/j', // decomposed u + combining diaeresis
      'https://xn--bcher-kva.example./j',
    ]
    expect(new Set(forms.map(hostOf))).toEqual(new Set(['xn--bcher-kva.example']))
  })

  it('keeps genuinely different hosts different', () => {
    expect(hostOf('https://bücher.example/j')).not.toBe(hostOf('https://bucher.example/j'))
  })
})
