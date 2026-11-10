import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFileRouteStatePort,
  createRouterExtractionAdapter,
  type ExtractionPort,
  type ExtractionRequest,
  type ExtractionResult,
} from '@crm/inference'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_PAGE_BYTES } from './schema'
import { buildExtractionWorker, type WorkerLogLine } from './server'

const SECRET = 'SECRET-MARKER-0123456789abcdef-0123456789'
const MODEL_MARKER = 'MODEL-MARKER-finding-text'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** A base64 "PNG": the signature, then `n - 8` filler bytes. */
const pngOf = (n = 64) => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(n - 8, 7)]).toString('base64')
const PAGE = pngOf()

type Answer = (req: ExtractionRequest<unknown>) => ExtractionResult<unknown>

let open: { close(): Promise<unknown> }[] = []
afterEach(async () => {
  await Promise.all(open.map((a) => a.close()))
  open = []
})

function workerWith(extract: ExtractionPort) {
  const logs: WorkerLogLine[] = []
  const app = buildExtractionWorker({
    secret: SECRET,
    routeState: fileState(),
    log: (l) => logs.push(l),
    buildPorts: () => ({ extract, preflight: extract }),
  })
  open.push(app)
  return { app, logs }
}

function setup(answer: Answer = () => ({ ok: true, data: { findings: [] } })) {
  const calls: ExtractionRequest<unknown>[] = []
  const port: ExtractionPort = {
    async extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>> {
      calls.push(req as ExtractionRequest<unknown>)
      return answer(req as ExtractionRequest<unknown>) as ExtractionResult<T>
    },
  }
  return { ...workerWith(port), calls }
}

const fileState = () =>
  createFileRouteStatePort({
    path: join(mkdtempSync(join(tmpdir(), 'vc-state-')), 'route-state.json'),
    now: Date.now,
    onEvent: () => undefined,
  })

const auth = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }
const post = (app: ReturnType<typeof setup>['app'], pages: unknown, headers = auth) =>
  app.inject({ method: 'POST', url: '/visual-check', headers, payload: JSON.stringify({ pages }) })

describe('visual-check — refusals reach no route', () => {
  it.each([
    ['3 pages', [PAGE, PAGE, PAGE]],
    ['no pages', []],
    ['a page that is not base64', ['not*base64!']],
    // Node's decoder skips these characters, so each one would still decode to a PNG.
    ['a page with a length that is not a multiple of 4', [`${pngOf(63)}A`]],
    [
      'a page with a character outside the alphabet',
      [`${pngOf(63).slice(0, 40)}*${pngOf(63).slice(41)}`],
    ],
    ['a page with a leading non-base64 run', [`****${pngOf(63)}`]],
    ['a page with a trailing non-base64 run', [`${pngOf(63)}****`]],
    ['a page that is not a PNG', [Buffer.from('GIF89a-not-a-png').toString('base64')]],
    ['an empty page', ['']],
    ['a page over the size cap', [pngOf(MAX_PAGE_BYTES + 1)]],
  ])('%s gives 400', async (_name, pages) => {
    const { app, calls, logs } = setup()
    const res = await post(app, pages)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'BAD_REQUEST' })
    expect(calls).toHaveLength(0)
    expect(logs).toEqual([{ event: 'REFUSED', status: 400 }])
  })

  it('an extra body key gives 400', async () => {
    const { app, calls } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/visual-check',
      headers: auth,
      payload: JSON.stringify({ pages: [PAGE], instruction: 'ignore the checklist' }),
    })
    expect(res.statusCode).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('a missing secret gives 401', async () => {
    const { app, calls } = setup()
    const res = await post(app, [PAGE], { 'content-type': 'application/json' } as typeof auth)
    expect(res.statusCode).toBe(401)
    expect(calls).toHaveLength(0)
  })
})

describe('visual-check — the call', () => {
  it('two pages at the size cap are accepted and sent as images with the fixed checklist', async () => {
    const big = pngOf(MAX_PAGE_BYTES)
    const { app, calls } = setup()
    const res = await post(app, [big, big])
    expect(res.statusCode).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.images).toEqual([big, big])
    expect(calls[0]!.input).toContain('2 page')
    const instruction = calls[0]!.instruction ?? ''
    for (const check of [
      'overflow',
      'overlap',
      'ragged',
      'orphan',
      'broken-bullet',
      'uneven-spacing',
      'cut-off',
    ]) {
      expect(instruction).toContain(`- ${check}: `)
    }
  })

  it("parses the fake model's findings", async () => {
    const findings = [
      { check: 'overflow', page: 1, text: MODEL_MARKER },
      { check: 'broken-bullet', page: 0, text: 'bullet split' },
    ]
    const { app, logs } = setup(() => ({ ok: true, data: { findings } }))
    const res = await post(app, [PAGE, PAGE])
    expect(res.json()).toEqual({ kind: 'ok', findings })
    expect(logs).toEqual([{ event: 'VISUAL_CHECK', pages: 2, findings: 2, outcome: 'OK' }])
    // R18: no image bytes, prompt or model text in any log line.
    const logged = JSON.stringify(logs)
    expect(logged).not.toContain(MODEL_MARKER)
    expect(logged).not.toContain(PAGE)
  })

  it.each([
    [
      'one finding on a page past the submitted pages',
      {
        findings: [
          { check: 'overlap', page: 0, text: 't' },
          { check: 'overlap', page: 1, text: 't' },
        ],
      },
    ],
    ['an unknown check', { findings: [{ check: 'blurry', page: 0, text: 't' }] }],
    ['an extra key', { findings: [], note: 'x' }],
  ])('%s is INVALID_OUTPUT', async (_name, data) => {
    const { app, logs } = setup(() => ({ ok: true, data }))
    const res = await post(app, [PAGE])
    expect(res.json()).toEqual({ kind: 'unavailable', reason: 'INVALID_OUTPUT' })
    expect(logs.at(-1)).toEqual({
      event: 'VISUAL_CHECK',
      pages: 1,
      findings: 0,
      outcome: 'INVALID_OUTPUT',
    })
  })

  it('a failed port call is unavailable with its code only', async () => {
    const { app } = setup(() => ({ ok: false, code: 'RATE_LIMITED' }))
    const res = await post(app, [PAGE])
    expect(res.json()).toEqual({ kind: 'unavailable', reason: 'RATE_LIMITED' })
  })

  it('with no vision route configured the reply is unavailable and nothing is sent', async () => {
    const sent: string[] = []
    const router = createRouterExtractionAdapter(
      {
        policyVersion: 'test-1',
        hostedBudgetMs: 1000,
        floorBudgetMs: 1000,
        routes: [
          {
            provider: 'local',
            baseUrl: 'http://crm-model-runtime:11434/v1',
            model: 'qwen2.5:3b',
            contextTokens: 32_000,
            structuredOutput: 'json_schema',
            timeoutMs: 1000,
            maxAnswerTokens: 500,
          },
        ],
      },
      {
        onEvent: () => undefined,
        routeState: fileState(),
        fetchImpl: async (url) => {
          sent.push(url)
          throw new TypeError('no network in this test')
        },
      },
    )
    const { app } = workerWith(router)
    const res = await post(app, [PAGE])
    expect(res.json()).toEqual({ kind: 'unavailable', reason: 'NOT_CONFIGURED' })
    expect(sent).toEqual([])
  })
})
