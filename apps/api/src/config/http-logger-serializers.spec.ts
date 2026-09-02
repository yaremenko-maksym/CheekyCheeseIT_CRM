import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { createRedactingReqSerializer, redactInviteTokenFromUrl } from './http-logger-serializers'

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

// SR-M-10 (security-review PR #623 round 4): `createRedactingReqSerializer`
// itself had NO coverage at all — only the pure `redactInviteTokenFromUrl`
// helper it wraps was tested directly. Exercises the ACTUAL serializer
// function `main.ts` hands to Fastify's `logger.serializers.req`.
describe('createRedactingReqSerializer', () => {
  function makeRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
    return {
      method: 'GET',
      url: `/api/auth/invite/${'d'.repeat(64)}`,
      hostname: 'app.cheekycheese.tech',
      ip: '203.0.113.5',
      socket: { remotePort: 54321 },
      ...overrides,
    } as unknown as FastifyRequest
  }

  it('redacts the token in the url field, passes the rest through unchanged', () => {
    const serialize = createRedactingReqSerializer()
    const result = serialize(makeRequest())
    expect(result).toEqual({
      method: 'GET',
      url: '/api/auth/invite/[redacted]',
      hostname: 'app.cheekycheese.tech',
      remoteAddress: '203.0.113.5',
      remotePort: 54321,
    })
  })

  it('leaves an unrelated url untouched', () => {
    const serialize = createRedactingReqSerializer()
    const result = serialize(makeRequest({ url: '/api/auth/google/callback?code=abc' }))
    expect(result.url).toBe('/api/auth/google/callback?code=abc')
  })

  it('defaults remotePort to 0 when the socket is gone (closed connection)', () => {
    const serialize = createRedactingReqSerializer()
    const result = serialize(makeRequest({ socket: undefined } as Partial<FastifyRequest>))
    expect(result.remotePort).toBe(0)
  })
})
