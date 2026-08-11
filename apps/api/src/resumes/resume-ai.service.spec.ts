/**
 * ResumeAiService — AC4 (invalid JSON -> exactly one retry -> FAILED, no loop),
 * AC5 (daily quota -> actionable state with a reset time) and AC7 (injected
 * content never survives as an active link).
 *
 * `fetch` is stubbed throughout: no live Cloudflare call ever happens in tests
 * and no credential is needed (task §Границы).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  ResumeAiService,
  coerceToContentShape,
  extractJsonObject,
  nextUtcMidnight,
} from './resume-ai.service'

function makeService(env: Record<string, string | undefined> = {}): ResumeAiService {
  const config = {
    get: (key: string) =>
      key in env
        ? env[key]
        : (
            { CLOUDFLARE_ACCOUNT_ID: 'acct-1', CLOUDFLARE_AI_TOKEN: 'tok-1' } as Record<
              string,
              string
            >
          )[key],
  }
  return new ResumeAiService(config as never)
}

function aiResponse(body: string, usageTokens = 120): Response {
  return {
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(
        JSON.stringify({
          success: true,
          result: { response: body, usage: { total_tokens: usageTokens } },
        }),
      ),
  } as unknown as Response
}

const VALID_JSON = JSON.stringify({
  summary: 'Синьор',
  skills: ['TypeScript'],
  experience: [{ company: 'Acme', role: 'Lead', period: '2020–2024', bullets: ['a'] }],
  education: [],
  languages: [],
  links: [],
})

describe('ResumeAiService', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('AC4: invalid JSON -> exactly ONE retry -> FAILED (never loops)', async () => {
    fetchSpy
      .mockResolvedValueOnce(aiResponse('извини, вот твой ответ без json'))
      .mockResolvedValueOnce(aiResponse('всё ещё не json'))
    const service = makeService()

    const result = await service.extractStructure('a'.repeat(200))

    expect(fetchSpy).toHaveBeenCalledTimes(2) // initial + ONE retry, no more
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('MODEL_INVALID_JSON')
    expect(result.message).toMatch(/вручную/)
  })

  it('AC4: a valid second attempt after an invalid first one succeeds', async () => {
    fetchSpy.mockResolvedValueOnce(aiResponse('nope')).mockResolvedValueOnce(aiResponse(VALID_JSON))
    const service = makeService()

    const result = await service.extractStructure('a'.repeat(200))

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.content.skills).toEqual(['TypeScript'])
    // Tokens from BOTH calls are accumulated so the real spend is visible.
    expect(result.tokensUsed).toBe(240)
  })

  it('succeeds on the first attempt and reports token usage', async () => {
    fetchSpy.mockResolvedValueOnce(aiResponse(VALID_JSON, 99))
    const service = makeService()

    const result = await service.extractStructure('a'.repeat(200))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.tokensUsed).toBe(99)
  })

  it('AC5: HTTP 429 -> QUOTA_EXCEEDED with the next UTC-midnight reset, no retry', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: () => Promise.resolve('{"success":false,"errors":[{"code":3040}]}'),
    } as unknown as Response)
    const service = makeService()

    const result = await service.extractStructure('a'.repeat(200))

    expect(fetchSpy).toHaveBeenCalledTimes(1) // burning the retry on a quota wall would be pointless
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('QUOTA_EXCEEDED')
    expect(result.quotaResetsAt).not.toBeNull()
    expect(new Date(result.quotaResetsAt as string).getUTCHours()).toBe(0)
  })

  it('AC5: error code 3040 inside a non-429 body is also recognised as the quota wall', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(
          '{"success":false,"errors":[{"code":3040,"message":"You have exceeded your daily quota"}]}',
        ),
    } as unknown as Response)

    const result = await makeService().extractStructure('a'.repeat(200))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('QUOTA_EXCEEDED')
  })

  it('missing credentials -> AI_NOT_CONFIGURED without any network call', async () => {
    const service = makeService({
      CLOUDFLARE_ACCOUNT_ID: undefined,
      CLOUDFLARE_AI_TOKEN: undefined,
    })

    const result = await service.extractStructure('a'.repeat(200))

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('AI_NOT_CONFIGURED')
    expect(result.message).toMatch(/вручную/)
  })

  it('transport failure -> MODEL_ERROR, and the token never appears in the error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNRESET tok-1'))
    const service = makeService()

    const result = await service.extractStructure('a'.repeat(200))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('MODEL_ERROR')
    expect(result.message).not.toContain('tok-1')
  })

  it('caps the text sent to the model (token economy)', async () => {
    fetchSpy.mockResolvedValueOnce(aiResponse(VALID_JSON))
    await makeService().extractStructure('x'.repeat(100_000))

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>
    }
    const userMessage = body.messages[1]?.content ?? ''
    expect(userMessage.length).toBeLessThan(13_000)
  })

  it('AC7: a javascript: link produced by the model is dropped, not stored', async () => {
    fetchSpy.mockResolvedValueOnce(
      aiResponse(
        JSON.stringify({
          summary: 'x',
          skills: [],
          experience: [],
          education: [],
          languages: [],
          links: [
            { label: 'Портфолио', url: 'javascript:alert(1)' },
            { label: 'GitHub', url: 'https://github.com/ok' },
          ],
        }),
      ),
    )

    const result = await makeService().extractStructure('a'.repeat(200))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.content.links).toEqual([{ label: 'GitHub', url: 'https://github.com/ok' }])
  })

  it('AC7: markup in resume text survives as inert literal text (never interpreted)', async () => {
    fetchSpy.mockResolvedValueOnce(
      aiResponse(
        JSON.stringify({
          summary: '<script>alert(1)</script>',
          skills: [],
          experience: [],
          education: [],
          languages: [],
          links: [],
        }),
      ),
    )

    const result = await makeService().extractStructure('a'.repeat(200))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.content.summary).toBe('<script>alert(1)</script>')
  })
})

describe('extractJsonObject', () => {
  it('pulls JSON out of a fenced/prose-wrapped answer', () => {
    expect(extractJsonObject('Вот результат:\n```json\n{"a":1}\n```')).toBe('{"a":1}')
  })
  it('is string-aware — braces inside values do not unbalance it', () => {
    expect(extractJsonObject('{"a":"} not the end {","b":2}')).toBe('{"a":"} not the end {","b":2}')
  })
  it('handles escaped quotes inside strings', () => {
    expect(extractJsonObject('{"a":"say \\"hi\\""}')).toBe('{"a":"say \\"hi\\""}')
  })
  it('returns null when there is no object at all', () => {
    expect(extractJsonObject('completely empty')).toBeNull()
  })
})

describe('coerceToContentShape', () => {
  it('turns nulls and missing sections into empty values', () => {
    expect(coerceToContentShape({ summary: null, skills: null })).toEqual({
      summary: '',
      skills: [],
      experience: [],
      education: [],
      languages: [],
      links: [],
    })
  })

  it('trims over-long lists instead of failing the whole extraction', () => {
    const coerced = coerceToContentShape({
      skills: Array.from({ length: 500 }, (_, i) => `s${i}`),
    }) as { skills: string[] }
    expect(coerced.skills).toHaveLength(60)
  })

  it('coerces a numeric period into a string rather than blowing up validation', () => {
    const coerced = coerceToContentShape({
      experience: [{ company: 'A', role: 'B', period: 2024, bullets: null }],
    }) as { experience: Array<{ period: string; bullets: string[] }> }
    expect(coerced.experience[0]?.period).toBe('2024')
    expect(coerced.experience[0]?.bullets).toEqual([])
  })
})

describe('nextUtcMidnight', () => {
  it('returns the next 00:00 UTC boundary', () => {
    const at = nextUtcMidnight(new Date('2026-08-07T13:45:00Z'))
    expect(at.toISOString()).toBe('2026-08-08T00:00:00.000Z')
  })
})
