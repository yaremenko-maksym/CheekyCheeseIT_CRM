import { describe, expect, it } from 'vitest'
import { DEFAULT_JSON_LIMITS, type JsonLimits, parseBoundedJson } from './bounded-json'

/**
 * Every bound is asserted on BOTH sides — the value AT the limit accepted, the one past it
 * refused. A cap whose test only checks "far past the limit is refused" cannot tell `>` from `>=`,
 * which is a defect task 2.1 actually shipped.
 */

const limits = (overrides: Partial<JsonLimits> = {}): JsonLimits => ({
  maxBytes: 1_000,
  maxDepth: 5,
  maxNodes: 100,
  ...overrides,
})

/** `depth` levels of nested arrays around a scalar: depth 1 is the bare scalar. */
function nest(depth: number): string {
  return '['.repeat(depth - 1) + '1' + ']'.repeat(depth - 1)
}

describe('parseBoundedJson', () => {
  it('returns the parsed value for an ordinary payload', () => {
    const result = parseBoundedJson('{"jobs":[{"id":"a"}]}', limits())
    expect(result).toEqual({ ok: true, value: { jobs: [{ id: 'a' }] } })
  })

  it('refuses a body that is not JSON, and returns the refusal rather than throwing', () => {
    const result = parseBoundedJson('<html>Rate limited</html>', limits())
    expect(result).toMatchObject({ ok: false, reason: 'NOT_JSON' })
  })

  it('refuses an empty body', () => {
    expect(parseBoundedJson('', limits())).toMatchObject({ ok: false, reason: 'NOT_JSON' })
  })

  it('accepts a VALID empty envelope — an empty page is not a failure', () => {
    expect(parseBoundedJson('{"jobs":[]}', limits())).toEqual({
      ok: true,
      value: { jobs: [] },
    })
  })

  describe('the byte bound', () => {
    it('accepts a document of exactly maxBytes', () => {
      // `"<padding>"` — two quotes plus the padding.
      const text = `"${'a'.repeat(98)}"`
      expect(text).toHaveLength(100)
      expect(parseBoundedJson(text, limits({ maxBytes: 100 }))).toMatchObject({ ok: true })
    })

    it('refuses a document one byte past maxBytes', () => {
      const text = `"${'a'.repeat(99)}"`
      expect(text).toHaveLength(101)
      expect(parseBoundedJson(text, limits({ maxBytes: 100 }))).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_BYTES',
      })
    })

    it('measures UTF-8 BYTES, not characters — a multi-byte payload is not undercounted', () => {
      // Three characters, each three bytes, plus two quotes = 11 bytes.
      const text = '"№№№"'
      expect(text).toHaveLength(5)
      expect(parseBoundedJson(text, limits({ maxBytes: 11 }))).toMatchObject({ ok: true })
      expect(parseBoundedJson(text, limits({ maxBytes: 10 }))).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_BYTES',
      })
    })

    it('refuses on bytes BEFORE parsing, so an oversize body is never materialized as a value', () => {
      const result = parseBoundedJson('not json at all', limits({ maxBytes: 4 }))
      expect(result).toMatchObject({ ok: false, reason: 'TOO_MANY_BYTES' })
    })
  })

  describe('the depth bound', () => {
    it('accepts a payload nested exactly maxDepth levels', () => {
      expect(parseBoundedJson(nest(5), limits({ maxDepth: 5 }))).toMatchObject({ ok: true })
    })

    it('refuses a payload nested one level past maxDepth', () => {
      expect(parseBoundedJson(nest(6), limits({ maxDepth: 5 }))).toMatchObject({
        ok: false,
        reason: 'TOO_DEEP',
      })
    })

    it('counts a bare scalar as depth 1', () => {
      expect(parseBoundedJson('1', limits({ maxDepth: 1 }))).toMatchObject({ ok: true })
      expect(parseBoundedJson('[1]', limits({ maxDepth: 1 }))).toMatchObject({
        ok: false,
        reason: 'TOO_DEEP',
      })
    })

    it('measures object nesting the same as array nesting', () => {
      expect(parseBoundedJson('{"a":{"b":{"c":1}}}', limits({ maxDepth: 4 }))).toMatchObject({
        ok: true,
      })
      expect(parseBoundedJson('{"a":{"b":{"c":1}}}', limits({ maxDepth: 3 }))).toMatchObject({
        ok: false,
        reason: 'TOO_DEEP',
      })
    })

    /**
     * The reason the walk is iterative. 20 000 levels is comfortably inside the default byte
     * budget and overflows a recursive walk's stack — so a provider could kill the worker with a
     * response that passed every fetch-time bound. The assertion is that we get a REFUSAL, which a
     * recursive implementation cannot produce because it never returns.
     */
    it('refuses a 20 000-level payload without exhausting the call stack', () => {
      const result = parseBoundedJson(nest(20_000), DEFAULT_JSON_LIMITS)
      expect(result).toMatchObject({ ok: false, reason: 'TOO_DEEP' })
    })
  })

  describe('the node bound', () => {
    it('accepts a payload of exactly maxNodes', () => {
      // One array node plus nine scalars.
      const text = JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9])
      expect(parseBoundedJson(text, limits({ maxNodes: 10 }))).toMatchObject({ ok: true })
    })

    it('refuses a payload one node past maxNodes', () => {
      const text = JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(parseBoundedJson(text, limits({ maxNodes: 10 }))).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_NODES',
      })
    })

    /**
     * What the node bound catches that the depth bound cannot see: a FLAT payload. Depth 2
     * throughout, so a depth-only guard passes it.
     */
    it('refuses a wide flat payload that the depth bound passes', () => {
      const text = JSON.stringify(Array.from({ length: 500 }, (_, i) => i))
      expect(
        parseBoundedJson(text, limits({ maxBytes: 100_000, maxDepth: 64, maxNodes: 100 })),
      ).toMatchObject({ ok: false, reason: 'TOO_MANY_NODES' })
    })

    it('counts object keys as nodes, so a wide object is bounded too', () => {
      const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]))
      const text = JSON.stringify(wide)
      expect(parseBoundedJson(text, limits({ maxBytes: 100_000, maxNodes: 51 }))).toMatchObject({
        ok: true,
      })
      expect(parseBoundedJson(text, limits({ maxBytes: 100_000, maxNodes: 50 }))).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_NODES',
      })
    })
  })

  it('never echoes the body in its refusal detail', () => {
    const result = parseBoundedJson('{"key":"TOPSECRET"', limits())
    expect(result).toMatchObject({ ok: false, reason: 'NOT_JSON' })
    // The WHOLE result, not just the detail: a secret anywhere in it is a leak.
    expect(JSON.stringify(result)).not.toContain('TOPSECRET')
  })
})
