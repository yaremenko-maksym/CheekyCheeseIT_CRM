import { describe, expect, it } from 'vitest'
import { redactInviteTokenFromUrl } from './http-logger-serializers'

describe('redactInviteTokenFromUrl', () => {
  it('redacts a raw invite token from the invite-accept path', () => {
    const token = 'a'.repeat(64)
    expect(redactInviteTokenFromUrl(`/api/auth/invite/${token}`)).toBe(
      '/api/auth/invite/[redacted]',
    )
  })

  it('leaves an unrelated URL untouched', () => {
    const url = '/api/auth/google/callback?code=abc&state=def'
    expect(redactInviteTokenFromUrl(url)).toBe(url)
  })

  it('does not redact a too-short hex-looking path segment (not a real token)', () => {
    const url = '/api/auth/invite/abc123'
    expect(redactInviteTokenFromUrl(url)).toBe(url)
  })

  it('does not redact a 64-hex segment on an unrelated path', () => {
    const hex64 = 'b'.repeat(64)
    const url = `/api/documents/${hex64}`
    expect(redactInviteTokenFromUrl(url)).toBe(url)
  })

  it('redacts even when the path is followed by other segments', () => {
    const token = 'c'.repeat(64)
    expect(redactInviteTokenFromUrl(`/api/auth/invite/${token}/`)).toBe(
      '/api/auth/invite/[redacted]/',
    )
  })
})
