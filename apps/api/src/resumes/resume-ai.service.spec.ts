/**
 * ResumeAiService — AC4 (invalid JSON -> exactly one retry -> FAILED, no loop),
 * AC5 (daily quota -> actionable state with a reset time) and AC7 (injected
 * content never survives as an active link).
 *
 * `fetch` is stubbed throughout: no live Cloudflare call ever happens in tests
 * and no credential is needed (task §Границы).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type AddressInfo } from 'node:net'
import { Logger } from '@nestjs/common'
import { decodeResumeMessage, encodeResumeMessage } from '@crm/shared'
import {
  ResumeAiService,
  coerceToContentShape,
  extractJsonObject,
  failedBeforeRequest,
  nextUtcMidnight,
} from './resume-ai.service'

/**
 * In-memory stand-in for the daily budget: `limit` calls a day, counted per `reserveCall`, given
 * back per `releaseCall` (never below 0, like the real statement).
 */
function fakeBudget(limit = Number.POSITIVE_INFINITY) {
  let used = 0
  const reserveCall = vi.fn((_now?: Date) => {
    if (used >= limit) return Promise.resolve(false)
    used += 1
    return Promise.resolve(true)
  })
  const releaseCall = vi.fn((_now?: Date) => {
    used = Math.max(0, used - 1)
    return Promise.resolve()
  })
  return { reserveCall, releaseCall, used: () => used }
}

function makeService(
  env: Record<string, string | undefined> = {},
  budget: { reserveCall: () => Promise<boolean>; releaseCall?: () => Promise<void> } = fakeBudget(),
): ResumeAiService {
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
  return new ResumeAiService(config as never, budget as never)
}

function aiResponse(body: unknown, usageTokens = 120): Response {
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

/** What `fetch` rejects with when the connect fails: undici wraps the socket/DNS error as `cause`. */
function fetchFailed(code?: string): TypeError {
  return new TypeError('fetch failed', code === undefined ? undefined : { cause: { code } })
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
    expect(decodeResumeMessage(result.message, 'RESUME_ERROR_DETAILS_UNAVAILABLE')).toEqual({
      code: 'RESUME_AI_INVALID_ANSWER',
    })
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

  it.each([
    ['an answer with no JSON object', 'no json here', 'the answer holds no JSON object'],
    ['an answer whose JSON does not parse', '{"summary": }', 'the JSON does not parse'],
  ])('the retry tells the model what was wrong with %s', async (_name, first, reason) => {
    fetchSpy.mockResolvedValueOnce(aiResponse(first)).mockResolvedValueOnce(aiResponse(VALID_JSON))

    await makeService().extractStructure('a'.repeat(200))

    const retryBody = (fetchSpy.mock.calls[1]?.[1] as RequestInit | undefined)?.body
    expect(String(retryBody)).toContain(reason)
  })

  it('succeeds on the first attempt and reports token usage', async () => {
    vi.useFakeTimers()
    try {
      fetchSpy.mockResolvedValueOnce(aiResponse(VALID_JSON, 99))
      const service = makeService()

      const result = await service.extractStructure('a'.repeat(200))

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.tokensUsed).toBe(99)
      // SO-2: the request timer is cleared on the success path (no fake timer left pending).
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
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
    expect(decodeResumeMessage(result.message, 'RESUME_ERROR_DETAILS_UNAVAILABLE')).toEqual({
      code: 'RESUME_AI_QUOTA_EXCEEDED',
    })
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

  describe('daily call budget', () => {
    it('blocks call N+1 with QUOTA_EXCEEDED and the next UTC midnight, without a fetch', async () => {
      fetchSpy.mockResolvedValue(aiResponse(VALID_JSON))
      const warn = vi.spyOn(Logger.prototype, 'warn')
      const budget = fakeBudget(2)
      const service = makeService({}, budget)

      expect((await service.extractStructure('a'.repeat(200))).ok).toBe(true)
      expect((await service.extractStructure('a'.repeat(200))).ok).toBe(true)
      const before = nextUtcMidnight().toISOString()
      const result = await service.extractStructure('a'.repeat(200))

      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(budget.reserveCall).toHaveBeenCalledTimes(3)
      expect(result).toEqual({
        ok: false,
        code: 'QUOTA_EXCEEDED',
        message: expect.any(String),
        quotaResetsAt: before,
        tokensUsed: null,
      })
      if (result.ok) throw new Error('unreachable')
      expect(decodeResumeMessage(result.message, 'RESUME_ERROR_DETAILS_UNAVAILABLE')).toEqual({
        code: 'RESUME_AI_QUOTA_EXCEEDED',
      })
      expect(warn).toHaveBeenCalledWith(
        'Resume AI daily call budget is spent; no Cloudflare request made',
      )
    })

    it('counts the corrective retry: a spent budget stops it and keeps the first tokens', async () => {
      fetchSpy.mockResolvedValueOnce(aiResponse('не json', 77))
      const budget = fakeBudget(1)
      const service = makeService({}, budget)

      const result = await service.extractStructure('a'.repeat(200))

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(budget.reserveCall).toHaveBeenCalledTimes(2)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('QUOTA_EXCEEDED')
      expect(result.tokensUsed).toBe(77)
    })

    it('a valid answer after an invalid one reserves exactly two calls', async () => {
      fetchSpy
        .mockResolvedValueOnce(aiResponse('не json'))
        .mockResolvedValueOnce(aiResponse(VALID_JSON))
      const budget = fakeBudget(2)
      const service = makeService({}, budget)

      expect((await service.extractStructure('a'.repeat(200))).ok).toBe(true)
      expect(budget.reserveCall).toHaveBeenCalledTimes(2)
    })

    it('fails closed when the budget cannot be read: MODEL_ERROR, no fetch', async () => {
      const error = vi.spyOn(Logger.prototype, 'error')
      const budget = { reserveCall: vi.fn(() => Promise.reject(new Error('db down'))) }
      const service = makeService({}, budget)

      const result = await service.extractStructure('a'.repeat(200))

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(result).toEqual({
        ok: false,
        code: 'MODEL_ERROR',
        message: expect.any(String),
        quotaResetsAt: null,
        tokensUsed: null,
      })
      if (result.ok) throw new Error('unreachable')
      expect(decodeResumeMessage(result.message, 'RESUME_ERROR_DETAILS_UNAVAILABLE')).toEqual({
        code: 'RESUME_AI_UNAVAILABLE',
      })
      expect(error).toHaveBeenCalledWith('Resume AI daily budget unreadable, call refused: db down')
    })

    it('CR-M-1: a refusal at 00:00 UTC reports the reset of the day it was refused for', async () => {
      vi.useFakeTimers({ now: new Date('2026-11-17T23:59:59.999Z') })
      try {
        // The clock crosses midnight while the reservation statement runs.
        const reserveCall = vi.fn((_now?: Date) => {
          vi.setSystemTime(new Date('2026-11-18T00:00:00.001Z'))
          return Promise.resolve(false)
        })
        const result = await makeService({}, { reserveCall }).extractStructure('a'.repeat(200))

        expect(reserveCall).toHaveBeenCalledWith(new Date('2026-11-17T23:59:59.999Z'))
        expect(result).toMatchObject({
          code: 'QUOTA_EXCEEDED',
          quotaResetsAt: '2026-11-18T00:00:00.000Z',
        })
      } finally {
        vi.useRealTimers()
      }
    })

    describe('R1: a call Cloudflare cannot have billed is given back', () => {
      it('a connect-refused error (ECONNREFUSED, no HTTP response) releases the reserved call', async () => {
        fetchSpy.mockRejectedValueOnce(fetchFailed('ECONNREFUSED'))
        const budget = fakeBudget(10)
        const result = await makeService({}, budget).extractStructure('a'.repeat(200))

        expect(result).toMatchObject({ ok: false, code: 'MODEL_ERROR', tokensUsed: null })
        expect(result).not.toHaveProperty('unbilled')
        expect(budget.releaseCall).toHaveBeenCalledTimes(1)
        // The release targets the same instant (so the same UTC day) as the reservation.
        expect(budget.releaseCall.mock.calls[0]?.[0]).toBe(budget.reserveCall.mock.calls[0]?.[0])
        expect(budget.reserveCall.mock.calls[0]?.[0]).toBeInstanceOf(Date)
        expect(budget.used()).toBe(0)
      })

      it('our own timeout keeps the call spent: Cloudflare may have run (and billed) it', async () => {
        vi.useFakeTimers()
        try {
          fetchSpy.mockImplementationOnce(
            (_url, init) =>
              new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () =>
                  reject(new DOMException('The operation was aborted.', 'AbortError')),
                )
              }),
          )
          const budget = fakeBudget(10)
          const pending = makeService({}, budget).extractStructure('a'.repeat(200))
          await vi.advanceTimersByTimeAsync(60_000)
          const result = await pending

          expect(result).toMatchObject({ ok: false, code: 'MODEL_ERROR' })
          expect(result).not.toHaveProperty('unbilled')
          expect(budget.releaseCall).not.toHaveBeenCalled()
          expect(budget.used()).toBe(1)
        } finally {
          vi.useRealTimers()
        }
      })

      it('B1: a response body that rejects is MODEL_ERROR, not a throw, and keeps the call spent', async () => {
        vi.useFakeTimers()
        try {
          const error = vi.spyOn(Logger.prototype, 'error')
          // A connect-phase code on purpose: headers arrived, so the call must stay spent anyway.
          fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: () => Promise.reject(fetchFailed('ECONNREFUSED')),
          } as unknown as Response)
          const budget = fakeBudget(10)
          const result = await makeService({}, budget).extractStructure('a'.repeat(200))

          expect(result).toMatchObject({
            ok: false,
            code: 'MODEL_ERROR',
            message: encodeResumeMessage('RESUME_AI_UNAVAILABLE'),
            tokensUsed: null,
          })
          // Headers came back: the request was sent and may be billed, so it is NOT unbilled.
          expect(result).not.toHaveProperty('unbilled')
          expect(budget.releaseCall).not.toHaveBeenCalled()
          expect(budget.used()).toBe(1)
          expect(error).toHaveBeenCalledWith('Workers AI response body failed: TypeError')
          // SO-2: the request timer is cleared on the failed-body path too.
          expect(vi.getTimerCount()).toBe(0)
        } finally {
          vi.useRealTimers()
        }
      })

      it('B1: a connect failure that is not an Error is logged as "request" with "unknown error"', async () => {
        const error = vi.spyOn(Logger.prototype, 'error')
        fetchSpy.mockRejectedValueOnce('boom')
        const budget = fakeBudget(10)
        await makeService({}, budget).extractStructure('a'.repeat(200))

        expect(error).toHaveBeenCalledWith('Workers AI request failed: unknown error')
        // Not a TypeError, so not certainly pre-request: the call stays spent.
        expect(budget.used()).toBe(1)
      })

      it('B1: a response body that never ends is aborted by the 60 s timer and keeps the call spent', async () => {
        vi.useFakeTimers()
        try {
          fetchSpy.mockImplementationOnce((_url, init) =>
            Promise.resolve({
              ok: true,
              status: 200,
              text: () =>
                new Promise<string>((_resolve, reject) => {
                  init?.signal?.addEventListener('abort', () =>
                    reject(new DOMException('The operation was aborted.', 'AbortError')),
                  )
                }),
            } as unknown as Response),
          )
          const budget = fakeBudget(10)
          const pending = makeService({}, budget).extractStructure('a'.repeat(200))
          await vi.advanceTimersByTimeAsync(60_000)
          const result = await pending

          expect(result).toMatchObject({
            ok: false,
            code: 'MODEL_ERROR',
            message: encodeResumeMessage('RESUME_AI_UNAVAILABLE'),
          })
          expect(result).not.toHaveProperty('unbilled')
          expect(budget.releaseCall).not.toHaveBeenCalled()
          expect(budget.used()).toBe(1)
          // SO-2: the timer fired (60 s), so it is no longer pending; the count is 0 with or without clearTimeout.
          expect(vi.getTimerCount()).toBe(0)
        } finally {
          vi.useRealTimers()
        }
      })

      it('an HTTP 429 releases the reserved call and keeps the quota answer', async () => {
        fetchSpy.mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: () => Promise.resolve('{"success":false,"errors":[{"code":3036}]}'),
        } as unknown as Response)
        const budget = fakeBudget(10)
        const result = await makeService({}, budget).extractStructure('a'.repeat(200))

        expect(result).toEqual({
          ok: false,
          code: 'QUOTA_EXCEEDED',
          message: expect.any(String),
          quotaResetsAt: expect.any(String),
          tokensUsed: null,
        })
        expect(budget.releaseCall).toHaveBeenCalledTimes(1)
        expect(budget.used()).toBe(0)
      })

      it('SO-1: a 429 whose body cannot be read still releases the reserved call', async () => {
        const error = vi.spyOn(Logger.prototype, 'error')
        fetchSpy.mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: () => Promise.reject(new Error('body stream reset')),
        } as unknown as Response)
        const budget = fakeBudget(10)
        const result = await makeService({}, budget).extractStructure('a'.repeat(200))

        // The body is unknown, so the code stays MODEL_ERROR; a 429 is never billed, so the call is released.
        expect(result).toEqual({
          ok: false,
          code: 'MODEL_ERROR',
          message: encodeResumeMessage('RESUME_AI_UNAVAILABLE'),
          quotaResetsAt: null,
          tokensUsed: null,
        })
        expect(error).toHaveBeenCalledWith('Workers AI response body failed: Error')
        expect(budget.releaseCall).toHaveBeenCalledTimes(1)
        expect(budget.used()).toBe(0)
      })

      it('R4: a 429 that lands after midnight reports the reset of the reserving day', async () => {
        vi.useFakeTimers({ now: new Date('2026-11-17T23:59:30.000Z') })
        try {
          // The request is in flight across 00:00 UTC; the 429 arrives on the next day.
          fetchSpy.mockImplementationOnce(() => {
            vi.setSystemTime(new Date('2026-11-18T00:00:05.000Z'))
            return Promise.resolve({
              ok: false,
              status: 429,
              text: () => Promise.resolve('{"success":false,"errors":[{"code":3036}]}'),
            } as unknown as Response)
          })
          const result = await makeService({}, fakeBudget(10)).extractStructure('a'.repeat(200))

          expect(result).toMatchObject({
            code: 'QUOTA_EXCEEDED',
            quotaResetsAt: '2026-11-18T00:00:00.000Z',
          })
        } finally {
          vi.useRealTimers()
        }
      })

      describe('R3: only a failure certainly before the request was sent is given back', () => {
        it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])(
          'a connect failure (%s) releases the reserved call',
          async (code) => {
            fetchSpy.mockRejectedValueOnce(fetchFailed(code))
            const budget = fakeBudget(10)
            const result = await makeService({}, budget).extractStructure('a'.repeat(200))

            expect(result).toMatchObject({ ok: false, code: 'MODEL_ERROR' })
            expect(budget.releaseCall).toHaveBeenCalledTimes(1)
            expect(budget.used()).toBe(0)
          },
        )

        it.each([
          ['ECONNRESET (the body may have been sent)', fetchFailed('ECONNRESET')],
          ['UND_ERR_SOCKET (socket closed mid-request)', fetchFailed('UND_ERR_SOCKET')],
          ['a fetch failure with no cause', fetchFailed()],
          ['an unknown code', fetchFailed('E_SOMETHING_NEW')],
          [
            'an allowlisted code on an error that is not the fetch TypeError',
            new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
          ],
        ])('%s keeps the call spent', async (_name, err) => {
          fetchSpy.mockRejectedValueOnce(err)
          const budget = fakeBudget(10)
          const result = await makeService({}, budget).extractStructure('a'.repeat(200))

          expect(result).toMatchObject({ ok: false, code: 'MODEL_ERROR' })
          expect(budget.releaseCall).not.toHaveBeenCalled()
          expect(budget.used()).toBe(1)
        })
      })

      it('a released retry keeps the tokens of the first attempt', async () => {
        fetchSpy
          .mockResolvedValueOnce(aiResponse('не json', 55))
          .mockRejectedValueOnce(fetchFailed('ECONNREFUSED'))
        const budget = fakeBudget(10)
        const result = await makeService({}, budget).extractStructure('a'.repeat(200))

        expect(result).toMatchObject({ ok: false, code: 'MODEL_ERROR', tokensUsed: 55 })
        expect(budget.releaseCall).toHaveBeenCalledTimes(1)
        expect(budget.releaseCall.mock.calls[0]?.[0]).toBe(budget.reserveCall.mock.calls[1]?.[0])
        expect(budget.used()).toBe(1)
      })

      it.each([
        [
          '3040 inside a 400',
          400,
          '{"success":false,"errors":[{"code":3040,"message":"daily quota"}]}',
        ],
        ['a 500', 500, '{"success":false,"errors":[{"message":"boom"}]}'],
        ['a 400', 400, '{"success":false,"errors":[{"message":"bad"}]}'],
      ])('any other answer (%s) keeps the call spent', async (_name, status, body) => {
        fetchSpy.mockResolvedValueOnce({
          ok: false,
          status,
          text: () => Promise.resolve(body),
        } as unknown as Response)
        const budget = fakeBudget(10)
        const result = await makeService({}, budget).extractStructure('a'.repeat(200))

        expect(result.ok).toBe(false)
        expect(result).not.toHaveProperty('unbilled')
        expect(budget.releaseCall).not.toHaveBeenCalled()
        expect(budget.used()).toBe(1)
      })

      it('a success or an invalid answer keeps every call spent', async () => {
        fetchSpy
          .mockResolvedValueOnce(aiResponse('не json'))
          .mockResolvedValueOnce(aiResponse(VALID_JSON))
        const budget = fakeBudget(10)
        expect((await makeService({}, budget).extractStructure('a'.repeat(200))).ok).toBe(true)
        expect(budget.releaseCall).not.toHaveBeenCalled()
        expect(budget.used()).toBe(2)
      })

      it('a failed release is logged and the call stays counted; the answer is unchanged', async () => {
        const error = vi.spyOn(Logger.prototype, 'error')
        fetchSpy.mockRejectedValueOnce(fetchFailed('ECONNREFUSED'))
        const budget = {
          reserveCall: vi.fn(() => Promise.resolve(true)),
          releaseCall: vi.fn(() => Promise.reject(new Error('db down'))),
        }
        const result = await makeService({}, budget).extractStructure('a'.repeat(200))

        expect(result).toMatchObject({ ok: false, code: 'MODEL_ERROR' })
        expect(error).toHaveBeenCalledWith(
          'Resume AI daily budget release failed; the call stays counted: db down',
        )
      })

      it('logs a non-Error release failure without its value', async () => {
        const error = vi.spyOn(Logger.prototype, 'error')
        fetchSpy.mockRejectedValueOnce(fetchFailed('ECONNREFUSED'))
        const budget = {
          reserveCall: () => Promise.resolve(true),
          releaseCall: () => Promise.reject('opaque'),
        }
        expect((await makeService({}, budget).extractStructure('a'.repeat(200))).ok).toBe(false)
        expect(error).toHaveBeenCalledWith(
          'Resume AI daily budget release failed; the call stays counted: unknown error',
        )
      })
    })

    it('logs a non-Error budget failure without its value', async () => {
      const error = vi.spyOn(Logger.prototype, 'error')
      const service = makeService({}, { reserveCall: () => Promise.reject('opaque') })

      expect((await service.extractStructure('a'.repeat(200))).ok).toBe(false)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledWith(
        'Resume AI daily budget unreadable, call refused: unknown error',
      )
    })
  })

  it('missing credentials -> AI_NOT_CONFIGURED without any network call', async () => {
    const budget = fakeBudget()
    const service = makeService(
      {
        CLOUDFLARE_ACCOUNT_ID: undefined,
        CLOUDFLARE_AI_TOKEN: undefined,
      },
      budget,
    )

    const result = await service.extractStructure('a'.repeat(200))

    expect(budget.reserveCall).not.toHaveBeenCalled() // an unconfigured app spends no budget
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('AI_NOT_CONFIGURED')
    expect(decodeResumeMessage(result.message, 'RESUME_ERROR_DETAILS_UNAVAILABLE')).toEqual({
      code: 'RESUME_AI_NOT_CONFIGURED',
    })
  })

  it('transport failure -> MODEL_ERROR, and the token never appears in the error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNRESET tok-1'))
    const service = makeService()

    const result = await service.extractStructure('a'.repeat(200))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('MODEL_ERROR')
    expect(result.message).not.toContain('tok-1')
    expect(decodeResumeMessage(result.message, 'RESUME_ERROR_DETAILS_UNAVAILABLE')).toEqual({
      code: 'RESUME_AI_UNAVAILABLE',
    })
  })

  it('calls a Workers AI model that is not deprecated (llama-3.1-8b-instruct-awq answers 410)', async () => {
    fetchSpy.mockResolvedValueOnce(aiResponse(VALID_JSON))
    await makeService().extractStructure('Jane Doe, engineer')

    expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(
      /\/ai\/run\/@cf\/mistralai\/mistral-small-3\.1-24b-instruct$/,
    )
  })

  it('accepts a response the model returned already parsed as an object', async () => {
    fetchSpy.mockResolvedValueOnce(aiResponse(JSON.parse(VALID_JSON)))
    const result = await makeService().extractStructure('Jane Doe, engineer')

    expect(result.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('treats a non-string, non-object response as invalid output', async () => {
    fetchSpy.mockResolvedValueOnce(aiResponse(42)).mockResolvedValueOnce(aiResponse(null))
    const result = await makeService().extractStructure('Jane Doe, engineer')

    expect(result).toMatchObject({ ok: false, code: 'MODEL_INVALID_JSON' })
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

describe('failedBeforeRequest: shape guard against the real global fetch', () => {
  it('recognises the connect-phase error undici throws on a closed loopback port', async () => {
    // Bind an ephemeral loopback port, then close it: nothing listens there, so the connect is
    // a real ECONNREFUSED with no external network. (Port 1 is not usable: undici refuses it
    // as a "bad port" before any connect, and that error carries no code.)
    const port = await new Promise<number>((resolve) => {
      const srv = createServer()
      srv.listen(0, '127.0.0.1', () => {
        const bound = (srv.address() as AddressInfo).port
        srv.close(() => resolve(bound))
      })
    })
    const err: unknown = await fetch(`http://127.0.0.1:${port}/`).then(
      () => new Error('expected the closed port to refuse the connection'),
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(TypeError)
    expect((err as TypeError & { cause?: { code?: unknown } }).cause?.code).toBe('ECONNREFUSED')
    expect(failedBeforeRequest(err)).toBe(true)
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
