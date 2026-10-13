import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { extractJsonObject, parseExtraction, runExtraction } from './extraction-pipeline'

const schema = z.object({ title: z.string() })

describe('extractJsonObject', () => {
  it('extracts a top-level object from noisy text', () =>
    expect(extractJsonObject('prefix {"title":"x"} suffix')).toBe('{"title":"x"}'))
  it('handles nested objects', () =>
    expect(extractJsonObject('x {"a":{"b":1}} y {"c":2}')).toBe('{"a":{"b":1}}'))
  it('ignores braces inside strings', () =>
    expect(extractJsonObject('{"t":"a } b { c"} tail')).toBe('{"t":"a } b { c"}'))
  it('handles escaped quotes inside strings', () =>
    expect(extractJsonObject('{"t":"say \\"}\\" ok"}')).toBe('{"t":"say \\"}\\" ok"}'))
  it('returns null when there is no object', () => expect(extractJsonObject('no json')).toBeNull())
  it('returns null for an unbalanced object', () =>
    expect(extractJsonObject('{"title":"x"')).toBeNull())
})

describe('parseExtraction', () => {
  it('parses valid output', () =>
    expect(parseExtraction('{"title":"x"}', schema)).toEqual({ ok: true, data: { title: 'x' } }))
  it('fails on invalid JSON', () => expect(parseExtraction('{bad}', schema)).toEqual({ ok: false }))
  it('fails on schema mismatch', () =>
    expect(parseExtraction('{"wrong":1}', schema)).toEqual({ ok: false }))
  it('strips control characters from string leaves', () =>
    expect(parseExtraction('{"title":"a\\u0000b\\u0007c"}', schema)).toEqual({
      ok: true,
      data: { title: 'abc' },
    }))
  it('strips control characters in nested arrays and objects', () => {
    const s = z.object({ tags: z.array(z.string()), n: z.object({ v: z.string() }) })
    expect(parseExtraction('{"tags":["a\\u0000"],"n":{"v":"\\u0001x"}}', s)).toEqual({
      ok: true,
      data: { tags: ['a'], n: { v: 'x' } },
    })
  })
})

describe('extraction pipeline', () => {
  it('returns typed data on first valid response', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, text: '{"title":"x"}' })
    const r = await runExtraction({ schema, call })
    expect(r).toEqual({ ok: true, data: { title: 'x' } })
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('retries once on invalid JSON then succeeds, passing a correction', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: 'not json' })
      .mockResolvedValueOnce({ ok: true, text: '{"title":"y"}' })
    const r = await runExtraction({ schema, call })
    expect(r).toEqual({ ok: true, data: { title: 'y' } })
    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls[0]).toEqual([])
    expect(typeof call.mock.calls[1]?.[0]).toBe('string')
    expect((call.mock.calls[1]?.[0] as string).length).toBeGreaterThan(0)
  })
  it('returns INVALID_OUTPUT after the corrective retry still fails (200 + schema-invalid)', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, text: '{"wrong":1}' })
    const r = await runExtraction({ schema, call })
    expect(r).toEqual({ ok: false, code: 'INVALID_OUTPUT' })
    expect(call).toHaveBeenCalledTimes(2)
  })
  it('short-circuits a transport failure without retrying', async () => {
    const call = vi.fn().mockResolvedValue({ ok: false, code: 'RATE_LIMITED' })
    expect(await runExtraction({ schema, call })).toEqual({ ok: false, code: 'RATE_LIMITED' })
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('passes an adapter-specific transport code straight through', async () => {
    const call = vi.fn().mockResolvedValue({ ok: false, code: 'MODEL_UNAVAILABLE' })
    expect(await runExtraction({ schema, call })).toEqual({ ok: false, code: 'MODEL_UNAVAILABLE' })
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('returns the transport code when the retry call itself fails', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: 'garbage' })
      .mockResolvedValueOnce({ ok: false, code: 'TIMEOUT' })
    expect(await runExtraction({ schema, call })).toEqual({ ok: false, code: 'TIMEOUT' })
    expect(call).toHaveBeenCalledTimes(2)
  })
})
