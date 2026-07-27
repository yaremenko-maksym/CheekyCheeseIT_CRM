import { describe, expect, it } from 'vitest'
import { isAllowedDocumentOrigin } from './origin-check'

const OUR_ORIGIN = 'https://app.cheekycheese.tech'

describe('isAllowedDocumentOrigin', () => {
  it('accepts a document-uri whose origin matches an allowed string exactly', () => {
    expect(isAllowedDocumentOrigin(`${OUR_ORIGIN}/team?foo=bar`, [OUR_ORIGIN])).toBe(true)
  })

  it('rejects a document-uri from a DIFFERENT origin — the mass-reflection vector (HIGH-1d)', () => {
    expect(isAllowedDocumentOrigin('https://evil.example/attacker-page', [OUR_ORIGIN])).toBe(false)
  })

  it('rejects an empty/undefined/null document-uri', () => {
    expect(isAllowedDocumentOrigin('', [OUR_ORIGIN])).toBe(false)
    expect(isAllowedDocumentOrigin(undefined, [OUR_ORIGIN])).toBe(false)
    expect(isAllowedDocumentOrigin(null, [OUR_ORIGIN])).toBe(false)
  })

  it('rejects a malformed (unparseable) document-uri', () => {
    expect(isAllowedDocumentOrigin('not a url at all', [OUR_ORIGIN])).toBe(false)
  })

  it('matches via a RegExp entry (dev-tunnel allowlist shape)', () => {
    expect(isAllowedDocumentOrigin('https://abc123.serveo.net/team', [/\.serveo\.net$/])).toBe(true)
  })

  it('rejects when a RegExp entry does not match', () => {
    expect(isAllowedDocumentOrigin('https://evil.example/x', [/\.serveo\.net$/])).toBe(false)
  })

  it('is exact-match, not prefix/substring — a look-alike origin is rejected', () => {
    expect(
      isAllowedDocumentOrigin('https://app.cheekycheese.tech.evil.example/x', [OUR_ORIGIN]),
    ).toBe(false)
  })

  it('ignores the path/query when comparing — only the origin matters', () => {
    expect(
      isAllowedDocumentOrigin(`${OUR_ORIGIN}/deep/nested/path?a=1&b=2#frag`, [OUR_ORIGIN]),
    ).toBe(true)
  })
})
