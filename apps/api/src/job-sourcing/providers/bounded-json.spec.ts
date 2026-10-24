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

    /**
     * SIBLING brackets must not accumulate. Without the closing-bracket branch the counter only
     * ever climbs, so five sibling arrays read as five levels of nesting and a perfectly ordinary
     * page is refused — the bound would reject real traffic rather than hostile traffic.
     */
    it('does not accumulate depth across sibling ARRAYS', () => {
      expect(scanDepthWithin('[[1],[2],[3],[4],[5]]', 3)).toBe(3)
      expect(parseBoundedJson('[[1],[2],[3],[4],[5]]', limits({ maxDepth: 3 }))).toMatchObject({
        ok: true,
      })
    })

    /** The same for objects, so that neither closing bracket can be dropped on its own. */
    it('does not accumulate depth across sibling OBJECTS', () => {
      const text = '{"a":{"b":1},"c":{"d":1},"e":{"f":1}}'
      expect(scanDepthWithin(text, 3)).toBe(3)
      expect(parseBoundedJson(text, limits({ maxDepth: 3 }))).toMatchObject({ ok: true })
    })

    /**
     * The first character inside a string must not be treated as escaped. Here it IS a quote, so
     * swallowing it leaves the string open and the `[` that follows reads as content — depth 2
     * instead of 3. The only input shape that can tell a stale initial escape state apart.
     */
    it('does not start out mid-escape', () => {
      expect(scanDepthWithin('{"":[1]}', 10)).toBe(3)
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

  /**
   * The refusal DETAIL is what an operator reads to size a limit, so it has to name the measured
   * figure and the limit it broke. Asserted against hand-written numbers, never against the
   * constant the code used — that would be the tautology the mutation gate exists to catch.
   */
  describe('the refusal detail names both numbers', () => {
    it('names the byte count and the byte cap', () => {
      const result = parseBoundedJson(`"${'a'.repeat(99)}"`, limits({ maxBytes: 100 }))
      expect(result).toMatchObject({ reason: 'TOO_MANY_BYTES', detail: '101 bytes exceeds 100' })
    })

    it('names the depth cap', () => {
      expect(parseBoundedJson(nest(9), limits({ maxDepth: 8 }))).toMatchObject({
        reason: 'TOO_DEEP',
        detail: 'nesting exceeds 8',
      })
    })

    it('names the node cap', () => {
      const text = JSON.stringify([1, 2, 3, 4])
      expect(parseBoundedJson(text, limits({ maxNodes: 3 }))).toMatchObject({
        reason: 'TOO_MANY_NODES',
        detail: 'node count exceeds 3',
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

/**
 * Backlog 318: the node bound used to fire only AFTER `JSON.parse`, so a flat hostile body inside
 * the byte cap and the depth limit was parsed in full before it was refused. The estimate is taken
 * from the raw text, string-aware, and must be an UPPER BOUND of the post-parse count.
 *
 * Every expected figure is a hand-counted literal, never a re-derivation of the code's own sum.
 */
describe('the pre-parse node bound', () => {
  const MiB = 1024 * 1024
  const wide = (over: Partial<JsonLimits> = {}): JsonLimits => ({
    maxBytes: 20 * MiB,
    maxDepth: 64,
    maxNodes: 200_000,
    ...over,
  })

  it('refuses a 10 MiB [0,0,...] body WITHOUT calling the parser', () => {
    const body = '[' + '0,'.repeat(5 * MiB - 2) + '0]'
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(10 * MiB)
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const result = parseBoundedJson(body, wide({ maxBytes: 10 * MiB }))
      expect(result).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_NODES',
        detail: 'node count exceeds 200000',
      })
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('refuses a 10 MiB [{},{},...] body WITHOUT calling the parser', () => {
    const body = '[' + '{},'.repeat(Math.floor((10 * MiB - 2) / 3)) + '{}]'
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const result = parseBoundedJson(body, wide({ maxBytes: 11 * MiB }))
      expect(result).toMatchObject({ ok: false, reason: 'TOO_MANY_NODES' })
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  describe('boundaries, array shape', () => {
    // [0,0,0] is the array plus three scalars: 4 nodes, by hand.
    it('accepts exactly maxNodes and refuses one past it', () => {
      expect(parseBoundedJson('[0,0,0]', limits({ maxNodes: 4 }))).toMatchObject({ ok: true })
      expect(parseBoundedJson('[0,0,0]', limits({ maxNodes: 3 }))).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_NODES',
      })
    })

    it('refuses one past the limit from the scan, not the parser', () => {
      const parse = vi.spyOn(JSON, 'parse')
      try {
        parseBoundedJson('[0,0,0]', limits({ maxNodes: 3 }))
        expect(parse).not.toHaveBeenCalled()
      } finally {
        parse.mockRestore()
      }
    })
  })

  describe('boundaries, object shape', () => {
    // The object plus three values: 4 nodes, by hand.
    const text = '{"a":0,"b":0,"c":0}'
    it('accepts exactly maxNodes and refuses one past it', () => {
      expect(parseBoundedJson(text, limits({ maxNodes: 4 }))).toMatchObject({ ok: true })
      expect(parseBoundedJson(text, limits({ maxNodes: 3 }))).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_NODES',
      })
    })
  })

  describe('string state at its edges', () => {
    // 1 array + 2 strings = 3 nodes. Commas and brackets INSIDE the strings are not structure.
    it('does not count commas, brackets or braces inside strings', () => {
      const text = '["a,b,c,d,e,f","[{,},]"]'
      expect(parseBoundedJson(text, limits({ maxNodes: 3 }))).toMatchObject({ ok: true })
    })

    it('does not let an escaped quote end the string (commas after it stay content)', () => {
      const text = '["a\\"b,c,d,e",1]' // array + 2 = 3 nodes
      expect(JSON.parse(text)).toHaveLength(2)
      expect(parseBoundedJson(text, limits({ maxNodes: 3 }))).toMatchObject({ ok: true })
      expect(parseBoundedJson(text, limits({ maxNodes: 2 }))).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_NODES',
      })
    })

    it('lets the quote after an escaped backslash end the string (the next comma is structure)', () => {
      const text = '["\\\\",1,2]' // array + 3 = 4 nodes
      expect(JSON.parse(text)).toHaveLength(3)
      expect(parseBoundedJson(text, limits({ maxNodes: 4 }))).toMatchObject({ ok: true })
      expect(parseBoundedJson(text, limits({ maxNodes: 3 }))).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_NODES',
      })
    })

    /**
     * What would this test's green look like if commas INSIDE strings were counted? Red: ~4 MiB of
     * prose with a comma every ~10 characters (~400k commas) against a 200k-node limit, yet only
     * 3 real nodes. It is the false refusal the naive cure would ship.
     */
    it('passes ~4 MiB of comma-heavy prose that has few real nodes', () => {
      const prose = 'lorem, ipsum dolor, sit amet, '.repeat(Math.ceil((4 * MiB) / 30))
      const text = JSON.stringify({ description: prose, title: 'x' })
      expect(Buffer.byteLength(text)).toBeGreaterThan(4 * MiB)
      expect(prose.split(',').length).toBeGreaterThan(400_000)
      expect(parseBoundedJson(text, wide())).toMatchObject({ ok: true })
    })
  })

  describe('an upper bound of the post-parse count', () => {
    // Accepted at the hand-counted true count: an estimate BELOW the truth is not the failure
    // here (that would let a body through); an estimate far above it is a false refusal.
    // Counts: containers plus every value, keys not counted.
    it.each([
      ['[[1],[2]]', 5],
      ['{"a":[1,2],"b":{"c":3}}', 6],
      ['42', 1],
      ['"x"', 1],
    ])('%s is accepted at its true count of %i', (text, nodes) => {
      expect(parseBoundedJson(text, limits({ maxNodes: nodes }))).toMatchObject({ ok: true })
    })

    it.each([
      ['[[1],[2]]', 4],
      ['{"a":[1,2],"b":{"c":3}}', 5],
    ])('%s is refused below its true count (limit %i)', (text, limit) => {
      expect(parseBoundedJson(text, limits({ maxNodes: limit }))).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_NODES',
      })
    })
  })

  it('still reports NOT_JSON for a small malformed body', () => {
    expect(parseBoundedJson('[1,,', limits())).toMatchObject({ ok: false, reason: 'NOT_JSON' })
  })

  it('names whichever bound a body breaks FIRST in the text when it breaks both', () => {
    // Deep before wide: the sixth opening bracket trips depth 5 long before 20 nodes accrue.
    const deepFirst = `${'['.repeat(10)}${'1,'.repeat(50)}1${']'.repeat(10)}`
    expect(parseBoundedJson(deepFirst, limits({ maxDepth: 5, maxNodes: 20 }))).toMatchObject({
      reason: 'TOO_DEEP',
    })
    // Wide before deep: 20 nodes are exceeded by the commas, before any nesting begins.
    const wideFirst = `[${'1,'.repeat(50)}${'['.repeat(10)}1${']'.repeat(10)}]`
    expect(parseBoundedJson(wideFirst, limits({ maxDepth: 5, maxNodes: 20 }))).toMatchObject({
      reason: 'TOO_MANY_NODES',
    })
  })

  it('refuses a scalar root against a zero node limit', () => {
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expect(parseBoundedJson('1', limits({ maxNodes: 0 }))).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_NODES',
      })
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
    expect(parseBoundedJson('1', limits({ maxNodes: 1 }))).toMatchObject({ ok: true })
  })

  it('names nodes when the breach is at an OPENING that precedes a later depth breach', () => {
    // Five openings, no comma. maxNodes 2 is crossed by the second opening; maxDepth 4 only by the
    // fourth. With the node check deleted from the opening branch this reads TOO_DEEP.
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expect(parseBoundedJson('['.repeat(5), limits({ maxDepth: 4, maxNodes: 2 }))).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_NODES',
      })
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('names depth when ONE opening breaches both bounds (depth is checked first)', () => {
    // '[1]' under maxDepth 1 and maxNodes 1: the single opening crosses both.
    expect(parseBoundedJson('[1]', limits({ maxDepth: 1, maxNodes: 1 }))).toMatchObject({
      ok: false,
      reason: 'TOO_DEEP',
    })
  })

  // SPEC-M-1: the scan runs before the parser, so a malformed body is judged on its shape first.
  // Before backlog 318 this was NOT_JSON; the caller maps it to PAYLOAD_TOO_LARGE, not PARSE_DRIFT.
  it('reports TOO_MANY_NODES, not NOT_JSON, for a malformed body with too many separators', () => {
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expect(parseBoundedJson('[1,,,,,,,', limits({ maxNodes: 3 }))).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_NODES',
      })
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  // SPEC-L-2 / CR-M-2 / SR-L-2: the estimate counts every opening, so empty containers are
  // over-counted. Known conservative margin: an all-empty body is refused at about HALF the limit.
  describe('the empty-container over-count', () => {
    it('refuses a body whose exact count is within the limit, never the other way round', () => {
      // [{},{},{},{}]: exact 5 nodes (array + four objects); estimate 1 + 3 commas + 5 openings = 9.
      const text = '[{},{},{},{}]'
      expect(parseBoundedJson(text, limits({ maxNodes: 9 }))).toMatchObject({ ok: true })
      expect(parseBoundedJson(text, limits({ maxNodes: 8 }))).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_NODES',
      })
    })

    it('refuses an all-empty body at about half the node limit (documented ratio ~2)', () => {
      const text = '[' + '{},'.repeat(99) + '{}]' // exact 101 nodes, estimate 201
      expect(JSON.parse(text)).toHaveLength(100)
      expect(parseBoundedJson(text, limits({ maxBytes: 10_000, maxNodes: 150 }))).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_NODES',
      })
      expect(parseBoundedJson(text, limits({ maxBytes: 10_000, maxNodes: 201 }))).toMatchObject({
        ok: true,
      })
    })
  })

  it('refuses at the opening bracket that crosses the limit, not only at commas', () => {
    // [[[ : three nodes by openings alone, no comma anywhere.
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expect(parseBoundedJson('[[[]]]', limits({ maxNodes: 2 }))).toMatchObject({
        reason: 'TOO_MANY_NODES',
      })
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })
})
