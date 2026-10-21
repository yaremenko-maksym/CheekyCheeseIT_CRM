import { describe, expect, it, vi } from 'vitest'
import { MAX_FEED_BYTES } from '../rss'
import {
  DEFAULT_JSON_LIMITS,
  type JsonLimits,
  MAX_JSON_BYTES,
  parseBoundedJson,
  scanDepthWithin,
} from './bounded-json'

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
     * 20 000 levels is comfortably inside the default byte budget and overflows a recursive walk's
     * stack — so a provider could kill the worker with a response that passed every fetch-time
     * bound. The assertion is that we get a REFUSAL, which a recursive implementation cannot
     * produce because it never returns.
     */
    it('refuses a 20 000-level payload without exhausting the call stack', () => {
      const result = parseBoundedJson(nest(20_000), DEFAULT_JSON_LIMITS)
      expect(result).toMatchObject({ ok: false, reason: 'TOO_DEEP' })
    })

    /**
     * THE TEST THAT DISTINGUISHES A REAL FIX. A post-parse depth check also answers `TOO_DEEP`, so
     * a test asserting only the reason passes against an implementation that parses four million
     * levels in full first — measured at 819 ms and +264 MB RSS on Node 22 — and refuses them
     * afterwards. The claim the bound actually makes is "refused BEFORE the parser sees the
     * bytes", and the only deterministic way to assert that is that the parser is never reached.
     *
     * Not a timing proxy: a wall-clock threshold on shared CI is a flake, and an allocation delta
     * depends on when the collector runs. The spy asserts the mechanism itself.
     */
    it('refuses a deep payload WITHOUT ever calling the parser', () => {
      const parse = vi.spyOn(JSON, 'parse')
      try {
        const result = parseBoundedJson(nest(1_000_000), DEFAULT_JSON_LIMITS)
        expect(result).toMatchObject({ ok: false, reason: 'TOO_DEEP' })
        expect(parse).not.toHaveBeenCalled()
      } finally {
        parse.mockRestore()
      }
    })

    /** The other side of the same assertion: the spy is wired up and a valid document DOES reach
     * the parser, so the test above is not passing because the spy never sees anything. */
    it('does call the parser for a document inside every bound', () => {
      const parse = vi.spyOn(JSON, 'parse')
      try {
        expect(parseBoundedJson('{"jobs":[]}', DEFAULT_JSON_LIMITS)).toMatchObject({ ok: true })
        expect(parse).toHaveBeenCalledTimes(1)
      } finally {
        parse.mockRestore()
      }
    })
  })

  describe('the depth pre-scan', () => {
    it('does not count brackets inside a string literal as structure', () => {
      // Under-counting is the direction that lets a hostile payload through; over-counting here
      // would refuse a legitimate description full of brackets.
      expect(scanDepthWithin('{"a":"[[[[[[[[[["}', 3)).toBe(2)
      expect(parseBoundedJson('{"a":"[[[[[[[[[["}', limits({ maxDepth: 2 }))).toMatchObject({
        ok: true,
      })
    })

    /**
     * An escaped quote must not close the string, and the way to show it is the QUOTE PARITY of
     * everything after it. A scanner blind to the escape closes `"x\"` early, which flips every
     * following quote, and the `[` that really is structure ends up read as string content —
     * depth 2 instead of 3. UNDER-counting, the direction that lets a payload through.
     *
     * The earlier version of this test put the bracket inside a string either way, so it passed
     * against a scanner with no escape handling at all.
     */
    it('does not let an escaped quote close the string and hide real structure', () => {
      expect(scanDepthWithin('{"a":"x\\"y","b":[1]}', 10)).toBe(3)
      expect(parseBoundedJson('{"a":"x\\"y","b":[1]}', limits({ maxDepth: 2 }))).toMatchObject({
        ok: false,
        reason: 'TOO_DEEP',
      })
    })

    /** An escaped BACKSLASH consumes itself, so the quote after it still closes the string. A
     * scanner whose escape state never resets treats the rest of the document as one string. */
    it('lets the quote after an escaped backslash close the string', () => {
      expect(scanDepthWithin('{"a":"c:\\\\","b":[1]}', 10)).toBe(3)
    })

    it('returns null exactly one level past the limit, and the depth at it', () => {
      expect(scanDepthWithin(nest(5), 5)).toBe(5)
      expect(scanDepthWithin(nest(6), 5)).toBeNull()
    })

    it('reports a bare scalar as depth 1', () => {
      expect(scanDepthWithin('42', 1)).toBe(1)
    })
  })

  describe('the default byte budget', () => {
    /**
     * R-2 of the merged XML dependency review withdrew 8 MiB after measuring it and aligned on
     * 2 MiB — the same constant the existing RSS path already uses for the same job. Asserted
     * against `rss.ts` itself rather than against a literal, so the two cannot drift apart
     * silently: whichever side moves, this fails.
     */
    it('is the same 2 MiB the RSS path already enforces', () => {
      expect(MAX_JSON_BYTES).toBe(2 * 1024 * 1024)
      expect(MAX_JSON_BYTES).toBe(MAX_FEED_BYTES)
      expect(DEFAULT_JSON_LIMITS.maxBytes).toBe(MAX_JSON_BYTES)
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
