import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { extractIp, extractUserAgent, lastOctet } from './invoice-request.util'

function req(partial: { ip?: string; headers?: Record<string, string | string[] | undefined> }) {
  return { ip: partial.ip, headers: partial.headers ?? {} } as unknown as FastifyRequest
}

describe('extractIp', () => {
  it('prefers req.ip over x-forwarded-for', () => {
    expect(extractIp(req({ ip: '10.0.0.1', headers: { 'x-forwarded-for': '1.2.3.4' } }))).toBe(
      '10.0.0.1',
    )
  })

  it('falls back to the first x-forwarded-for entry, trimmed', () => {
    expect(extractIp(req({ headers: { 'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8' } }))).toBe('1.2.3.4')
  })

  it('reads the first element of an array x-forwarded-for, first entry, trimmed', () => {
    expect(
      extractIp(req({ headers: { 'x-forwarded-for': [' 9.9.9.9 , 8.8.8.8', '7.7.7.7'] } })),
    ).toBe('9.9.9.9')
  })

  it('treats an empty req.ip as absent', () => {
    expect(extractIp(req({ ip: '', headers: { 'x-forwarded-for': '1.2.3.4' } }))).toBe('1.2.3.4')
  })

  it('returns null for an empty string header', () => {
    expect(extractIp(req({ headers: { 'x-forwarded-for': '' } }))).toBeNull()
  })

  it('returns null for an empty array header', () => {
    expect(extractIp(req({ headers: { 'x-forwarded-for': [] } }))).toBeNull()
  })

  it('returns null when neither source is present', () => {
    expect(extractIp(req({}))).toBeNull()
  })
})

describe('extractUserAgent', () => {
  it('returns the user-agent header', () => {
    expect(extractUserAgent(req({ headers: { 'user-agent': 'Mozilla/5.0' } }))).toBe('Mozilla/5.0')
  })

  it('returns null for an empty header', () => {
    expect(extractUserAgent(req({ headers: { 'user-agent': '' } }))).toBeNull()
  })

  it('returns null when the header is missing', () => {
    expect(extractUserAgent(req({}))).toBeNull()
  })

  it('returns null for a non-string header value', () => {
    expect(extractUserAgent(req({ headers: { 'user-agent': ['a', 'b'] } }))).toBeNull()
  })
})

describe('lastOctet', () => {
  it('returns only the last octet of an IPv4 address', () => {
    expect(lastOctet('192.168.10.77')).toBe('77')
  })

  it('returns null for IPv6', () => {
    expect(lastOctet('2001:db8::1')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(lastOctet('')).toBeNull()
  })

  it('returns null for a malformed or padded address', () => {
    expect(lastOctet('1.2.3')).toBeNull()
    expect(lastOctet('1.2.3.4.5')).toBeNull()
    expect(lastOctet('x1.2.3.4')).toBeNull()
    expect(lastOctet('1.2.3.4x')).toBeNull()
  })
})
