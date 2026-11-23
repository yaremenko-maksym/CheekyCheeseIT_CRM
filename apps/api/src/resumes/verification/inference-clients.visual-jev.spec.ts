import type {
  BoundedResult,
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  ExtractionWorkerTransport,
} from '@crm/inference'
import type { ConfigService } from '@nestjs/config'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../config/env'
import { VISUAL_CHECK_DEFINITIONS, VISUAL_CHECKS } from '../../extraction-worker/link-contract'
import { narrowOrigin } from '../../tailored-resumes/tailored-runner'
import {
  checkVisualWithFallback,
  jevVisualFindings,
  unavailableOrigin,
  VISUAL_JEV_THRESHOLD,
  VISUAL_PAGE_ASSET,
  VISUAL_PROVIDER,
  VisualCheckClient,
} from './inference-clients'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9])

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
    expect(first?.assets).toEqual({
      [VISUAL_PAGE_ASSET]: { type: 'image', format: 'png', dataBase64: PNG.toString('base64') },
    })
    expect(second?.assets?.[VISUAL_PAGE_ASSET]?.dataBase64).toBe(PNG2.toString('base64'))
    expect(first?.questions.map((q) => [q.id, q.kind])).toEqual(
      VISUAL_CHECKS.map((c) => [c, 'noul']),
    )
    const overlap = first?.questions.find((q) => q.id === 'overlap')
    expect(overlap?.instructions).toContain(VISUAL_CHECK_DEFINITIONS.overlap)
    // The asset key is replaced inside every string: an instruction must never contain it.
    for (const q of first?.questions ?? []) expect(q.instructions).not.toContain(VISUAL_PAGE_ASSET)
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
    const p: DecisionPort = {
      decide: (req) => {
        if (req.assets?.[VISUAL_PAGE_ASSET]?.dataBase64 === PNG.toString('base64')) {
          return Promise.resolve(answers({ overflow: 0.9 }))
        }
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
    const r = await checkVisualWithFallback(
      port({ ok: false, code: 'RATE_LIMITED' }),
      workerDown(),
      [PNG],
      () => undefined,
    )
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
  afterEach(() => vi.unstubAllGlobals())

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
})
