import type {
  BoundedResult,
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  ExtractionWorkerTransport,
} from '@crm/inference'
import { Logger } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import sharp from 'sharp'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../config/env'
import { VISUAL_CHECK_DEFINITIONS, VISUAL_CHECKS } from '../../extraction-worker/link-contract'
import { narrowOrigin } from '../../tailored-resumes/tailored-runner'
import {
  checkVisualWithFallback,
  fitVisualPages,
  JEV_MAX_PAGE_SIDE,
  jevVisualFindings,
  unavailableOrigin,
  VISUAL_JEV_STRICT_THRESHOLD,
  VISUAL_JEV_THRESHOLD,
  VISUAL_PAGE_ASSET,
  VISUAL_PROVIDER,
  VisualCheckClient,
  type VisualOk,
} from './inference-clients'

const page = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer()
const size = async (b64: string | undefined) => {
  const m = await sharp(Buffer.from(b64 ?? '', 'base64')).metadata()
  return [m.format, m.width, m.height]
}
let PNG: Buffer
let PNG2: Buffer
const NOT_AN_IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
beforeAll(async () => {
  PNG = await page(100, 140, '#ffffff')
  PNG2 = await page(70, 50, '#000000')
})

/** Every check answered with `low`, except the ones named in `high`. */
function answers(high: Partial<Record<string, number>> = {}, low = 0.1): DecisionResult {
  return {
    ok: true,
    answers: VISUAL_CHECKS.map((c) => {
      const p = high[c] ?? low
      return { id: c, kind: 'noul' as const, value: p >= 0.5, probability: p }
    }),
  }
}

function port(...replies: DecisionResult[]): DecisionPort & { reqs: DecisionRequest[] } {
  const reqs: DecisionRequest[] = []
  return {
    reqs,
    decide: (req) => {
      reqs.push(req)
      return Promise.resolve(replies[reqs.length - 1] ?? answers())
    },
  }
}

type Posted = { route: string; body: string }
function worker(res: BoundedResult): ExtractionWorkerTransport & { posted: Posted[] } {
  const posted: Posted[] = []
  const post = ((route: string, init: { body: string }) => {
    posted.push({ route, body: init.body })
    return Promise.resolve(res)
  }) as ExtractionWorkerTransport
  return Object.assign(post, { posted })
}
const workerOk = (findings: unknown[]) =>
  worker({ kind: 'ok', text: JSON.stringify({ kind: 'ok', findings }) } as BoundedResult)
const workerDown = () => worker({ kind: 'timeout' } as BoundedResult)
/** The findings of a Jev result, or the unavailable result itself. */
const found = async (r: ReturnType<typeof jevVisualFindings>) => {
  const v = await r
  return 'findings' in v ? v.findings : v
}

describe('jevVisualFindings — the Jev reply as findings', () => {
  it('one Jev call per page, the page as its only image asset, one noul per check', async () => {
    const p = port()
    await jevVisualFindings(p, [PNG, PNG2])
    expect(p.reqs).toHaveLength(2)
    const [first, second] = p.reqs
    expect(first?.state).toBe(VISUAL_PAGE_ASSET)
    expect(Object.keys(first?.assets ?? {})).toEqual([VISUAL_PAGE_ASSET])
    const asset = first?.assets?.[VISUAL_PAGE_ASSET]
    expect([asset?.type, asset?.format]).toEqual(['image', 'png'])
    // A page within the limit keeps its size; each call carries its own page.
    expect(await size(asset?.dataBase64)).toEqual(['png', 100, 140])
    expect(await size(second?.assets?.[VISUAL_PAGE_ASSET]?.dataBase64)).toEqual(['png', 70, 50])
    expect(first?.questions.map((q) => [q.id, q.kind])).toEqual(
      VISUAL_CHECKS.map((c) => [c, 'noul']),
    )
    const overlap = first?.questions.find((q) => q.id === 'overlap')
    expect(overlap?.instructions).toContain(VISUAL_CHECK_DEFINITIONS.overlap)
    // The asset key is replaced inside every string: an instruction must never contain it.
    for (const q of first?.questions ?? []) expect(q.instructions).not.toContain(VISUAL_PAGE_ASSET)
  })

  it('a page rendered at 144 ppi is scaled down to the side Jev accepts; a small one is kept', async () => {
    expect(JEV_MAX_PAGE_SIDE).toBe(1400)
    const fitted = await fitVisualPages([await page(1191, 1684, '#ffffff'), PNG])
    if (!Array.isArray(fitted)) throw new Error('expected pages')
    expect(await size(fitted[0]?.toString('base64'))).toEqual(['png', 990, 1400])
    expect(await size(fitted[1]?.toString('base64'))).toEqual(['png', 100, 140])
  })

  it('a page that is not an image is IMAGE_DECODE, not the error class', async () => {
    await expect(fitVisualPages([PNG, NOT_AN_IMAGE])).resolves.toEqual({
      kind: 'unavailable',
      cause: 'IMAGE_DECODE',
    })
  })

  it('all pages are sent at once: the second page is asked before the first is answered', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((done) => (release = done))
    let calls = 0
    const p: DecisionPort = {
      decide: async () => {
        calls += 1
        if (calls === 2) release()
        await gate
        return answers()
      },
    }
    await expect(found(jevVisualFindings(p, [PNG, PNG2]))).resolves.toEqual([])
    expect(calls).toBe(2)
  })

  it('logs the 7 scores of every page in one line each, numbers only', async () => {
    const log = vi.fn()
    const r = await jevVisualFindings(
      port(answers({ overlap: 0.93 }), answers({}, 0.2)),
      [PNG, PNG2],
      log,
    )
    const page0 = Object.fromEntries(VISUAL_CHECKS.map((c) => [c, c === 'overlap' ? 0.93 : 0.1]))
    const page1 = Object.fromEntries(VISUAL_CHECKS.map((c) => [c, 0.2]))
    expect(log.mock.calls).toEqual([
      [{ event: 'resume_visual_jev_scores', provider: 'jev', page: 0, scores: page0 }],
      [{ event: 'resume_visual_jev_scores', provider: 'jev', page: 1, scores: page1 }],
    ])
    expect('scores' in r && r.scores).toEqual([page0, page1])
  })

  it('one probability over the threshold is exactly one finding with its check and page', async () => {
    const p = port(answers(), answers({ overlap: 0.93 }))
    const r = await found(jevVisualFindings(p, [PNG, PNG2]))
    expect(r).toEqual([{ check: 'overlap', page: 1, text: expect.any(String) as string }])
  })

  it('all probabilities below the threshold are no finding', async () => {
    const r = await found(jevVisualFindings(port(answers({}, 0.49), answers({}, 0)), [PNG, PNG2]))
    expect(r).toEqual([])
  })

  it('the threshold is inclusive: exactly at it is a finding, just below is not', async () => {
    expect(VISUAL_JEV_THRESHOLD).toBe(0.5)
    const at = await found(jevVisualFindings(port(answers({ 'cut-off': 0.5 })), [PNG]))
    expect(at).toEqual([{ check: 'cut-off', page: 0, text: expect.any(String) as string }])
    const below = await found(jevVisualFindings(port(answers({ 'cut-off': 0.4999 })), [PNG]))
    expect(below).toEqual([])
  })

  it('reads the probability, not the adapter value', async () => {
    const r: DecisionResult = {
      ok: true,
      answers: VISUAL_CHECKS.map((c) => ({
        id: c,
        kind: 'noul' as const,
        value: c === 'orphan',
        probability: c === 'ragged' ? 0.7 : 0.2,
      })),
    }
    expect(await found(jevVisualFindings(port(r), [PNG]))).toEqual([
      { check: 'ragged', page: 0, text: expect.any(String) as string },
    ])
  })

  it('every finding text is a fixed English sentence that fits the findings schema', async () => {
    const all = Object.fromEntries(VISUAL_CHECKS.map((c) => [c, 0.9]))
    const r = await found(jevVisualFindings(port(answers(all)), [PNG]))
    expect(Array.isArray(r) && r.map((f) => f.check)).toEqual([...VISUAL_CHECKS])
    const texts = Array.isArray(r) ? r.map((f) => f.text) : []
    expect(new Set(texts).size).toBe(VISUAL_CHECKS.length)
    for (const t of texts) {
      expect(t.length).toBeGreaterThan(0)
      expect(t.length).toBeLessThanOrEqual(400)
      expect(t).toMatch(/^[A-Z][^\n]*\.$/)
    }
  })

  it.each<[string, DecisionResult | 'throw' | 'throw-non-error', string]>([
    ['a coded failure', { ok: false, code: 'TIMEOUT' }, 'TIMEOUT'],
    ['a missing answer', { ok: true, answers: [] }, 'ANSWER_COUNT'],
    [
      'a non-noul answer',
      {
        ok: true,
        answers: VISUAL_CHECKS.map((c) => ({
          id: c,
          kind: 'score' as const,
          value: 1,
          confidence: 1,
        })),
      },
      'INVALID_ANSWER',
    ],
    [
      'an answer to a check that was not asked',
      {
        ok: true,
        answers: VISUAL_CHECKS.map((c, i) => ({
          id: i === 0 ? 'other' : c,
          kind: 'noul' as const,
          value: false,
          probability: 0,
        })),
      },
      'INVALID_ANSWER',
    ],
    [
      'a duplicated answer',
      {
        ok: true,
        answers: VISUAL_CHECKS.map((c, i) => ({
          id: i === 1 ? VISUAL_CHECKS[0] : c,
          kind: 'noul' as const,
          value: false,
          probability: 0,
        })),
      },
      'INVALID_ANSWER',
    ],
    ['a thrown port', 'throw', 'TypeError'],
    ['a thrown non-Error', 'throw-non-error', 'unknown'],
  ])('%s on one page makes the whole Jev attempt unavailable', async (_n, second, cause) => {
    let calls = 0
    const p: DecisionPort = {
      decide: () => {
        calls += 1
        if (calls === 1) return Promise.resolve(answers({ overflow: 0.9 }))
        if (second === 'throw') return Promise.reject(new TypeError('jane@x.test'))
        if (second === 'throw-non-error') return Promise.reject('jane@x.test')
        return Promise.resolve(second)
      },
    }
    // The finding on page 0 is not kept: a partial Jev result is never used.
    await expect(found(jevVisualFindings(p, [PNG, PNG2]))).resolves.toEqual({
      kind: 'unavailable',
      cause,
    })
  })
})

describe('checkVisualWithFallback — Jev first, the worker second', () => {
  it('Jev answers: its findings, the worker is not called', async () => {
    const w = workerOk([])
    const before = vi.fn(() => Promise.resolve())
    const r = await checkVisualWithFallback(port(answers({ overflow: 0.8 })), w, [PNG], undefined, {
      beforeFallback: before,
    })
    expect(r).toEqual({
      kind: 'ok',
      via: 'jev',
      findings: [{ check: 'overflow', page: 0, text: expect.any(String) as string }],
      scores: [Object.fromEntries(VISUAL_CHECKS.map((c) => [c, c === 'overflow' ? 0.8 : 0.1]))],
    })
    expect(w.posted).toHaveLength(0)
    expect(before).not.toHaveBeenCalled()
  })

  it('Jev unavailable: the run budget is checked before the worker fallback', async () => {
    const order: string[] = []
    const w = workerOk([])
    const post = ((route: string, init: { body: string }) => {
      order.push('worker')
      return w(route as never, init as never)
    }) as ExtractionWorkerTransport
    const before = () => {
      order.push('budget')
      return Promise.resolve()
    }
    await checkVisualWithFallback(port({ ok: false, code: 'TIMEOUT' }), post, [PNG], undefined, {
      beforeFallback: before,
    })
    expect(order).toEqual(['budget', 'worker'])
  })

  it('a spent budget stops the fallback: the throw propagates and the worker is not called', async () => {
    const w = workerOk([])
    const stalled = new Error('STALLED')
    await expect(
      checkVisualWithFallback(port({ ok: false, code: 'TIMEOUT' }), w, [PNG], undefined, {
        beforeFallback: () => Promise.reject(stalled),
      }),
    ).rejects.toBe(stalled)
    expect(w.posted).toHaveLength(0)
  })

  it('a page that cannot be decoded skips Jev; the worker gets the original page', async () => {
    const log = vi.fn()
    const p = port()
    const w = workerOk([])
    await checkVisualWithFallback(p, w, [NOT_AN_IMAGE], log)
    expect(p.reqs).toHaveLength(0)
    expect(w.posted).toEqual([
      {
        route: '/visual-check',
        body: JSON.stringify({ pages: [NOT_AN_IMAGE.toString('base64')] }),
      },
    ])
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event: 'resume_visual_jev_unavailable', cause: 'IMAGE_DECODE' }),
    )
  })

  it('Jev and the worker get the same scaled page, resized once', async () => {
    const big = await page(1191, 1684, '#ffffff')
    const p = port({ ok: false, code: 'TIMEOUT' })
    const w = workerOk([])
    const resize = vi.spyOn(sharp.prototype, 'resize')
    await checkVisualWithFallback(p, w, [big])
    expect(resize).toHaveBeenCalledTimes(1)
    const sent = p.reqs[0]?.assets?.[VISUAL_PAGE_ASSET]?.dataBase64
    expect(await size(sent)).toEqual(['png', 990, 1400])
    expect(w.posted[0]?.body).toBe(JSON.stringify({ pages: [sent] }))
  })

  it('Jev unavailable: the worker /visual-check is called with the pages and its reply returned', async () => {
    const log = vi.fn()
    const w = workerOk([{ check: 'orphan', page: 0, text: 'A heading is alone.' }])
    const r = await checkVisualWithFallback(port({ ok: false, code: 'TIMEOUT' }), w, [PNG], log)
    expect(w.posted.map((x) => x.route)).toEqual(['/visual-check'])
    const sent = (JSON.parse(w.posted[0]?.body ?? '{}') as { pages: string[] }).pages
    expect(await Promise.all(sent.map(size))).toEqual([['png', 100, 140]])
    expect(r).toEqual({
      kind: 'ok',
      findings: [{ check: 'orphan', page: 0, text: 'A heading is alone.' }],
    })
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: 'resume_visual_jev_unavailable',
      provider: 'jev',
      cause: 'TIMEOUT',
    })
  })

  it('no Jev key: the worker is called, the cause is NOT_CONFIGURED', async () => {
    const log = vi.fn()
    const w = workerOk([])
    await expect(checkVisualWithFallback(undefined, w, [PNG], log)).resolves.toEqual({
      kind: 'ok',
      findings: [],
    })
    expect(w.posted).toHaveLength(1)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ cause: 'NOT_CONFIGURED' }))
  })

  it('both unavailable: one origin names both providers and both causes', async () => {
    const log = vi.fn()
    const r = await checkVisualWithFallback(
      port({ ok: false, code: 'RATE_LIMITED' }),
      workerDown(),
      [PNG],
      log,
    )
    // The run-failure line is the only one: the client logs nothing itself.
    expect(log).not.toHaveBeenCalled()
    expect(r).toEqual({
      kind: 'unavailable',
      reason: 'TIMEOUT',
      transport: 'timeout',
      provider: `jev(RATE_LIMITED),${VISUAL_PROVIDER}`,
    })
    if (r.kind !== 'unavailable') throw new Error('expected unavailable')
    const origin = unavailableOrigin(r.provider ?? VISUAL_PROVIDER, r)
    expect(origin).toEqual({
      provider: 'jev(RATE_LIMITED),extraction-worker:/visual-check',
      reason: 'TIMEOUT:timeout',
      status: undefined,
    })
    // The tailored log narrows the reason to a code; the provider keeps both causes.
    expect(narrowOrigin(origin)).toEqual({
      provider: 'jev(RATE_LIMITED),extraction-worker:/visual-check',
      reason: 'TIMEOUT',
      status: undefined,
    })
  })

  const jevFirst = (p: number) =>
    ({
      kind: 'ok',
      via: 'jev',
      findings: [{ check: 'orphan', page: 0, text: 'x' }],
      scores: [Object.fromEntries(VISUAL_CHECKS.map((c) => [c, c === 'orphan' ? p : 0.1]))],
    }) as VisualOk

  it('confirming: only the worker is asked, never Jev, and its reply is returned', async () => {
    const p = port()
    const w = workerOk([{ check: 'orphan', page: 0, text: 'A heading is alone.' }])
    const r = await checkVisualWithFallback(p, w, [PNG], undefined, { confirming: jevFirst(0.6) })
    expect(p.reqs).toHaveLength(0)
    expect(w.posted).toHaveLength(1)
    expect(r).toEqual({
      kind: 'ok',
      findings: [{ check: 'orphan', page: 0, text: 'A heading is alone.' }],
    })
  })

  it('confirming a Jev finding with the worker down: kept at the strict threshold', async () => {
    expect(VISUAL_JEV_STRICT_THRESHOLD).toBe(0.85)
    const log = vi.fn()
    const at = await checkVisualWithFallback(port(), workerDown(), [PNG], log, {
      confirming: jevFirst(0.85),
    })
    expect(at).toEqual({ kind: 'ok', findings: [{ check: 'orphan', page: 0, text: 'x' }] })
    expect(log).not.toHaveBeenCalled()
  })

  it('confirming a Jev finding with the worker down: dropped below it, with one log line', async () => {
    const log = vi.fn()
    const below = await checkVisualWithFallback(port(), workerDown(), [PNG], log, {
      confirming: jevFirst(0.8499),
    })
    expect(below).toEqual({ kind: 'ok', findings: [] })
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: 'resume_visual_jev_unconfirmed_dropped',
      provider: 'jev',
      cause: 'TIMEOUT',
      dropped: [{ check: 'orphan', page: 0 }],
    })
  })

  it('confirming a worker finding with the worker down: unavailable, as before', async () => {
    const first: VisualOk = { kind: 'ok', findings: [{ check: 'orphan', page: 0, text: 'x' }] }
    const r = await checkVisualWithFallback(port(), workerDown(), [PNG], undefined, {
      confirming: first,
    })
    expect(r).toEqual({ kind: 'unavailable', reason: 'TIMEOUT', transport: 'timeout' })
  })

  it('pages over the limits are INVALID_INPUT with no call to either provider', async () => {
    const p = port()
    const w = workerOk([])
    const pages = [PNG, PNG, PNG]
    await expect(checkVisualWithFallback(p, w, pages, () => undefined)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'INVALID_INPUT',
    })
    expect(p.reqs).toHaveLength(0)
    expect(w.posted).toHaveLength(0)
  })
})

/**
 * As `@nestjs/config` 4.0.4: the 2nd argument is options only when it is exactly `{ infer: <truthy> }`;
 * anything else is the default value returned for an unset key.
 */
const config = (key: string | undefined) =>
  ({
    get: (k: string, second?: unknown) => {
      if (k !== 'JEV_API_KEY') return 'wrong-key'
      const isOptions =
        typeof second === 'object' &&
        second !== null &&
        Boolean((second as { infer?: unknown }).infer) &&
        Object.keys(second).length === 1
      return key ?? (isOptions ? undefined : second)
    },
  }) as unknown as ConfigService<Env, true>

describe('VisualCheckClient — the Jev key', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('no key: no Jev call, the first call goes to the worker', async () => {
    vi.stubEnv('EXTRACTION_WORKER_URL', 'http://crm-extraction-worker:3100')
    vi.stubEnv('EXTRACTION_WORKER_SECRET', 'SECRET-MARKER-0123456789abcdef-0123456789')
    const urls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url)
      return Promise.resolve(new Response(JSON.stringify({ kind: 'ok', findings: [] })))
    })
    await new VisualCheckClient(config(undefined)).check([PNG])
    expect(urls).toEqual(['http://crm-extraction-worker:3100/visual-check'])
  })

  it('with a key, the first call goes to Jev with the images header', async () => {
    const urls: string[] = []
    const headers: Record<string, string>[] = []
    vi.stubGlobal('fetch', (url: string, init: { headers: Record<string, string> }) => {
      urls.push(url)
      headers.push(init.headers)
      const wire = Object.fromEntries(VISUAL_CHECKS.map((c) => [c, { type: 'noul', noul: 0.1 }]))
      return Promise.resolve(new Response(JSON.stringify({ answers: wire })))
    })
    const info = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const r = await new VisualCheckClient(config('jev-key')).check([PNG])
    expect(r).toMatchObject({ kind: 'ok', via: 'jev', findings: [] })
    // The scores are logged at the info level, never as a warning.
    expect(info).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('"event":"resume_visual_jev_scores"'),
    )
    expect(warn).not.toHaveBeenCalled()
    expect(urls).toEqual(['https://api.typesafe.ai/v1/systemone'])
    expect(headers[0]?.['TypeSafe-Danger-Zone-Images']).toBe('true')
    expect(headers[0]?.Authorization).toBe('Bearer jev-key')
  })

  it('a Jev call stuck past 30 s falls back to the worker and logs the Jev cause', async () => {
    vi.stubEnv('EXTRACTION_WORKER_URL', 'http://crm-extraction-worker:3100')
    vi.stubEnv('EXTRACTION_WORKER_SECRET', 'SECRET-MARKER-0123456789abcdef-0123456789')
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const urls: string[] = []
    let reached: () => void = () => undefined
    const jevReached = new Promise<void>((done) => (reached = done))
    // Only the timers: the page resize runs on the thread pool and needs real I/O callbacks.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal('fetch', (url: string, init: { signal: AbortSignal }) => {
      urls.push(url)
      if (url.includes('typesafe')) {
        reached()
        return new Promise((_res, rej) =>
          init.signal.addEventListener('abort', () => rej(new Error('aborted'))),
        )
      }
      return Promise.resolve(new Response(JSON.stringify({ kind: 'ok', findings: [] })))
    })
    const r = new VisualCheckClient(config('jev-key')).check([PNG])
    await jevReached
    await vi.advanceTimersByTimeAsync(29_999)
    expect(urls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(r).resolves.toEqual({ kind: 'ok', findings: [] })
    expect(urls[1]).toBe('http://crm-extraction-worker:3100/visual-check')
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ event: 'resume_visual_jev_unavailable', provider: 'jev', cause: 'TIMEOUT' }),
    )
  })
})
