import { createHmac } from 'node:crypto'
import type { HttpException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import {
  assertCursorCurrent,
  type ContinuationCursor,
  type ListCursor,
  parseCursor,
  refreshRequired,
  requestSignature,
  signCursor,
} from './queue-cursor'

const SECRET = 'unit-test-secret-unit-test-secret'
const GEN = '11111111-1111-4111-8111-111111111111'
const KEY = '22222222-2222-4222-8222-222222222222'
const LIST: ListCursor = { t: 'L', g: GEN, k: 7, s: 'sig', e: 1_000 }
const SOURCES: ContinuationCursor = { t: 'SRC', g: GEN, k: KEY, s: 'sig', e: 1_000 }

function codeOf(fn: () => unknown): { status: number; code: string } {
  try {
    fn()
  } catch (err: unknown) {
    const e = err as HttpException
    return { status: e.getStatus(), code: (e.getResponse() as { code: string }).code }
  }
  throw new Error('expected a refusal')
}
const MALFORMED = { status: 400, code: 'JOB_QUEUE_CURSOR_MALFORMED' }
const REFRESH = { status: 409, code: 'JOB_QUEUE_REFRESH_REQUIRED' }

/** A correctly signed token around an arbitrary body: only the shape check can refuse it. */
const signRaw = (body: string) =>
  `${body}.${createHmac('sha256', SECRET).update(`job-queue-cursor.v1.${body}`).digest('base64url')}`
const signedJson = (payload: unknown) =>
  signRaw(Buffer.from(JSON.stringify(payload)).toString('base64url'))

describe('signCursor / parseCursor', () => {
  it('round-trips a list cursor and a continuation cursor', () => {
    expect(parseCursor(signCursor(LIST, SECRET), 'L', SECRET)).toEqual(LIST)
    expect(parseCursor(signCursor(SOURCES, SECRET), 'SRC', SECRET)).toEqual(SOURCES)
  })

  it('fits the 300 characters the wire schema allows', () => {
    const longest = { ...SOURCES, s: 'x'.repeat(22), e: 9_999_999_999 }
    expect(signCursor(longest, SECRET).length).toBeLessThanOrEqual(300)
  })

  it('is not plain text: the payload is base64url with a detached signature', () => {
    const [body, signature, extra] = signCursor(LIST, SECRET).split('.')
    expect(JSON.parse(Buffer.from(body as string, 'base64url').toString())).toEqual(LIST)
    expect(signature).toHaveLength(43)
    expect(extra).toBeUndefined()
  })

  it('refuses a cursor signed with another secret', () => {
    expect(codeOf(() => parseCursor(signCursor(LIST, 'other'), 'L', SECRET))).toEqual(MALFORMED)
  })

  it('refuses a tampered payload', () => {
    const [, signature] = signCursor(LIST, SECRET).split('.')
    const body = Buffer.from(JSON.stringify({ ...LIST, k: 8 })).toString('base64url')
    expect(codeOf(() => parseCursor(`${body}.${signature}`, 'L', SECRET))).toEqual(MALFORMED)
  })

  it('refuses a signature of the wrong length and a non-canonical spelling of the right one', () => {
    const token = signCursor(LIST, SECRET)
    const [body, signature] = token.split('.') as [string, string]
    expect(codeOf(() => parseCursor(`${body}.${signature.slice(0, 10)}`, 'L', SECRET))).toEqual(
      MALFORMED,
    )
    // base64 padding decodes to the same bytes: same MAC, different text.
    expect(codeOf(() => parseCursor(`${body}.${signature}=`, 'L', SECRET))).toEqual(MALFORMED)
  })

  it.each([
    ['no separator', 'abc'],
    ['an extra part', 'a.b.c'],
    ['empty', ''],
  ])('refuses %s', (_label, token) => {
    expect(codeOf(() => parseCursor(token, 'L', SECRET))).toEqual(MALFORMED)
  })

  it('refuses a validly signed body that is not JSON', () => {
    const token = signRaw(Buffer.from('not json').toString('base64url'))
    expect(codeOf(() => parseCursor(token, 'L', SECRET))).toEqual(MALFORMED)
  })

  it.each([
    ['a non-uuid generation', { ...LIST, g: 'x' }],
    ['a negative list key', { ...LIST, k: -1 }],
    ['a fractional list key', { ...LIST, k: 1.5 }],
    ['a list key that is a string', { ...LIST, k: '7' }],
    ['an extra field', { ...LIST, x: 1 }],
    ['an empty signature', { ...LIST, s: '' }],
    ['an overlong signature', { ...LIST, s: 'x'.repeat(65) }],
    ['a negative expiry', { ...LIST, e: -1 }],
    ['an unknown kind', { ...LIST, t: 'Z' }],
  ])('refuses a validly signed payload with %s', (_label, payload) => {
    expect(codeOf(() => parseCursor(signedJson(payload), 'L', SECRET))).toEqual(MALFORMED)
  })

  it('refuses a continuation key that is not a uuid (it reaches a ::uuid cast otherwise)', () => {
    const token = signedJson({ ...SOURCES, k: "x'; DROP" })
    expect(codeOf(() => parseCursor(token, 'SRC', SECRET))).toEqual(MALFORMED)
  })

  it('refuses a genuine cursor of another kind', () => {
    expect(codeOf(() => parseCursor(signCursor(LIST, SECRET), 'SRC', SECRET))).toEqual(MALFORMED)
    expect(codeOf(() => parseCursor(signCursor(SOURCES, SECRET), 'SEN', SECRET))).toEqual(MALFORMED)
  })
})

describe('assertCursorCurrent', () => {
  it('accepts the same signature one second before expiry', () => {
    expect(() => assertCursorCurrent(LIST, 'sig', new Date(999_000))).not.toThrow()
  })
  it('expires exactly at e', () => {
    expect(codeOf(() => assertCursorCurrent(LIST, 'sig', new Date(1_000_000)))).toEqual(REFRESH)
  })
  it('refuses another request signature', () => {
    expect(codeOf(() => assertCursorCurrent(LIST, 'other', new Date(0)))).toEqual(REFRESH)
  })
})

describe('refreshRequired', () => {
  it('is the stable 409', () => {
    expect(
      codeOf(() => {
        throw refreshRequired()
      }),
    ).toEqual(REFRESH)
  })
})

describe('requestSignature', () => {
  it('is a 22-character digest with a known value', () => {
    expect(requestSignature(['a'])).toBe('DrW41vgbxnfaighWfMT6mg')
  })
  it('keeps parts apart: ["ab","c"] is not ["a","bc"]', () => {
    expect(requestSignature(['ab', 'c'])).not.toBe(requestSignature(['a', 'bc']))
  })
})
