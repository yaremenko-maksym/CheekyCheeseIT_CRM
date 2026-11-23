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
  JEV_MAX_PAGE_SIDE,
  jevVisualFindings,
  unavailableOrigin,
  VISUAL_JEV_THRESHOLD,
  VISUAL_PAGE_ASSET,
  VISUAL_PROVIDER,
  VisualCheckClient,
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

  it('a page rendered at 144 ppi is sent scaled down to the side Jev accepts', async () => {
    expect(JEV_MAX_PAGE_SIDE).toBe(1400)
    const p = port()
    await jevVisualFindings(p, [await page(1191, 1684, '#ffffff')])
    expect(await size(p.reqs[0]?.assets?.[VISUAL_PAGE_ASSET]?.dataBase64)).toEqual([
      'png',
      990,
      1400,
    ])
  })

  it('a page that is not an image is unavailable before any Jev call', async () => {
    const p = port()
    const bad = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    await expect(jevVisualFindings(p, [bad])).resolves.toEqual({
      kind: 'unavailable',
      cause: 'Error',
    })
    expect(p.reqs).toHaveLength(0)
  })

  it('one probability over the threshold is exactly one finding with its check and page', async () => {
    const p = port(answers(), answers({ overlap: 0.93 }))
    const r = await jevVisualFindings(p, [PNG, PNG2])
    expect(r).toEqual([{ check: 'overlap', page: 1, text: expect.any(String) as string }])
  })

  it('all probabilities below the threshold are no finding', async () => {
    const r = await jevVisualFindings(port(answers({}, 0.49), answers({}, 0)), [PNG, PNG2])
    expect(r).toEqual([])
  })

  it('the threshold is inclusive: exactly at it is a finding, just below is not', async () => {
    expect(VISUAL_JEV_THRESHOLD).toBe(0.5)
    const at = await jevVisualFindings(port(answers({ 'cut-off': 0.5 })), [PNG])
    expect(at).toEqual([{ check: 'cut-off', page: 0, text: expect.any(String) as string }])
    const below = await jevVisualFindings(port(answers({ 'cut-off': 0.4999 })), [PNG])
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
    expect(await jevVisualFindings(port(r), [PNG])).toEqual([
      { check: 'ragged', page: 0, text: expect.any(String) as string },
    ])
  })

  it('every finding text is a fixed English sentence that fits the findings schema', async () => {
    const all = Object.fromEntries(VISUAL_CHECKS.map((c) => [c, 0.9]))
    const r = await jevVisualFindings(port(answers(all)), [PNG])
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
    await expect(jevVisualFindings(p, [PNG, PNG2])).resolves.toEqual({
      kind: 'unavailable',
      cause,
    })
  })
})

describe('checkVisualWithFallback — Jev first, the worker second', () => {
  it('Jev answers: its findings, the worker is not called', async () => {
    const w = workerOk([])
    const r = await checkVisualWithFallback(port(answers({ overflow: 0.8 })), w, [PNG])
    expect(r).toEqual({
      kind: 'ok',
      findings: [{ check: 'overflow', page: 0, text: expect.any(String) as string }],
    })
    expect(w.posted).toHaveLength(0)
  })

  it('Jev unavailable: the worker /visual-check is called with the pages and its reply returned', async () => {
    const log = vi.fn()
    const w = workerOk([{ check: 'orphan', page: 0, text: 'A heading is alone.' }])
    const r = await checkVisualWithFallback(port({ ok: false, code: 'TIMEOUT' }), w, [PNG], log)
    expect(w.posted).toEqual([
      { route: '/visual-check', body: JSON.stringify({ pages: [PNG.toString('base64')] }) },
    ])
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

const config = (key: string | undefined) =>
  ({ get: (k: string) => (k === 'JEV_API_KEY' ? key : 'wrong-key') }) as unknown as ConfigService<
    Env,
    true
  >

describe('VisualCheckClient — the Jev key', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
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
    const r = await new VisualCheckClient(config('jev-key')).check([PNG])
    expect(r).toEqual({ kind: 'ok', findings: [] })
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
