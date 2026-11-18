import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFileRouteStatePort,
  createOwnCapPort,
  createRouterExtractionAdapter,
  routerReadiness,
  type FetchLike,
} from '@crm/inference'
import { afterEach, describe, expect, it } from 'vitest'
import { resumeWriteInput, SUMMARY_INSTRUCTION } from './resume-write'
import { buildExtractionWorker, type WorkerLogLine } from './server'

/**
 * Resume writing through the OpenRouter route (AC 15, ADR §3.5, resume spec §3): the real router
 * behind the real worker, every route configured, the network faked. No admission rule: the route
 * takes part in the `largest` rule like any other route, and only the facts and the fixed
 * instruction travel to it.
 */
const SECRET = 'SECRET-MARKER-0123456789abcdef-0123456789'
const KEYS = {
  gemini: 'sk-GEMINI-KEY-MARKER',
  groq: 'sk-GROQ-KEY-MARKER',
  cloudflare: 'sk-CLOUDFLARE-KEY-MARKER',
  openrouter: 'sk-OPENROUTER-KEY-MARKER',
} as const
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef'
const MARKERS = [SECRET, ...Object.values(KEYS), ACCOUNT_ID]
const OR_LARGE = 'vendor/model-235b:free'
const OR_SMALL = 'vendor/model-70b:free'
const GROQ_MODEL = 'openai/gpt-oss-120b'
const COMMON = {
  contextTokens: 32_000,
  minGapMs: 0,
  timeoutMs: 5_000,
  maxAnswerTokens: 800,
  freeLimit: { requestsPerDay: 1000 },
}
const routes = (openRouterModel: string) => [
  {
    ...COMMON,
    provider: 'gemini',
    apiKey: KEYS.gemini,
    models: ['gemini-2.5-flash'],
    structuredOutput: 'json_schema',
  },
  {
    ...COMMON,
    provider: 'groq',
    apiKey: KEYS.groq,
    models: [GROQ_MODEL],
    structuredOutput: 'json_schema',
  },
  {
    ...COMMON,
    provider: 'cloudflare',
    apiKey: KEYS.cloudflare,
    models: ['@cf/mistralai/mistral-small-3.1-24b-instruct'],
    structuredOutput: 'none',
    accountId: ACCOUNT_ID,
    contextTokens: 16_000,
    freeLimit: { requestsPerDay: 16 },
  },
  {
    ...COMMON,
    provider: 'openrouter',
    apiKey: KEYS.openrouter,
    models: [openRouterModel],
    structuredOutput: 'json_schema',
    dataCollection: 'allow',
  },
]

type Sent = { host: string; url: string; body: Record<string, unknown> }

/** Every chat answers a valid summary, so the first request is the only one. */
function recordingFetch() {
  const sent: Sent[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    sent.push({
      host: new URL(url).hostname,
      url,
      body: JSON.parse(init?.body ?? '{}') as Record<string, unknown>,
    })
    const content = JSON.stringify({ summary: 'A written summary.' })
    return new Response(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { total_tokens: 10 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return { fetchImpl, sent }
}

const apps: { close: () => Promise<unknown> }[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()))
})

async function worker(openRouterModel = OR_LARGE) {
  const config = {
    policyVersion: 'ac15-1',
    hostedBudgetMs: 10_000,
    routes: routes(openRouterModel),
  }
  const path = join(mkdtempSync(join(tmpdir(), 'xw-rw-or-')), 'route-state.json')
  const routeState = await createFileRouteStatePort({
    path,
    now: Date.now,
    onEvent: () => undefined,
  })
  const net = recordingFetch()
  const logs: WorkerLogLine[] = []
  const app = buildExtractionWorker({
    secret: SECRET,
    routeState,
    log: (l) => logs.push(l),
    buildPorts: (onEvent) => ({
      extract: createRouterExtractionAdapter(config, {
        onEvent,
        routeState,
        ownCap: createOwnCapPort({ state: routeState, now: Date.now }),
        fetchImpl: net.fetchImpl,
        sleep: async () => undefined,
      }),
      readiness: () => routerReadiness(config, { routeState }),
    }),
  })
  apps.push(app)
  return { app, net, logs }
}

const auth = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }
const FACTS = JSON.stringify({
  headline: 'Backend engineer',
  skills: ['TypeScript', 'PostgreSQL'],
  experience: [{ company: 'Acme', role: 'Engineer', dates: '2021-2024', technologies: ['Node'] }],
})
const writeBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ task: 'summary', payload: FACTS, feedback: [], ...extra })
const write = (app: Awaited<ReturnType<typeof worker>>['app'], payload: string) =>
  app.inject({ method: 'POST', url: '/resume-write', headers: auth, payload })

describe('resume-write through the OpenRouter route (AC 15)', () => {
  it('largest rule across routes: a larger OpenRouter model takes the first request', async () => {
    const { app, net } = await worker(OR_LARGE)
    const res = await write(app, writeBody())
    expect(res.statusCode).toBe(200)
    expect(net.sent).toHaveLength(1)
    expect(net.sent[0]!.host).toBe('openrouter.ai')
    expect(net.sent[0]!.body.model).toBe(OR_LARGE)
  })

  it('largest rule across routes: a smaller OpenRouter model yields the first request to Groq', async () => {
    const { app, net } = await worker(OR_SMALL)
    const res = await write(app, writeBody())
    expect(res.statusCode).toBe(200)
    expect(net.sent).toHaveLength(1)
    expect(net.sent[0]!.host).toBe('api.groq.com')
    expect(net.sent[0]!.body.model).toBe(GROQ_MODEL)
  })

  it('the OpenRouter request carries its routing fields, the facts and the fixed instruction only', async () => {
    const { app, net, logs } = await worker(OR_LARGE)
    const res = await write(app, writeBody())
    expect(res.statusCode).toBe(200)
    const [req] = net.sent
    expect(req!.host).toBe('openrouter.ai')
    expect(req!.body.provider).toEqual({
      max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
      require_parameters: true,
      data_collection: 'allow',
      ignore: [],
    })
    expect(req!.body.messages).toEqual([
      { role: 'system', content: SUMMARY_INSTRUCTION },
      { role: 'user', content: resumeWriteInput(FACTS, []) },
    ])
    for (const field of ['models', 'route', 'transforms'])
      expect(req!.body).not.toHaveProperty(field)
    // The log was written at all: an empty capture would pass the marker checks below.
    expect(logs.length).toBeGreaterThan(0)
    const surfaces = [req!.url, JSON.stringify(req!.body), JSON.stringify(logs)]
    for (const text of surfaces) for (const m of MARKERS) expect(text).not.toContain(m)
  })

  it.each([
    ['name', { name: 'Jane Doe' }],
    ['email', { email: 'jane@example.com' }],
    ['phone', { phone: '+380 50 123 4567' }],
    ['link', { link: 'https://example.com/jane' }],
  ])('a %s field beside the payload gives 400 and reaches no route', async (_f, extra) => {
    const { app, net } = await worker(OR_LARGE)
    const res = await write(app, writeBody(extra))
    expect(res.statusCode).toBe(400)
    expect(net.sent).toHaveLength(0)
  })

  it('positive control: the same body without the field is sent', async () => {
    const { app, net } = await worker(OR_LARGE)
    expect((await write(app, writeBody())).statusCode).toBe(200)
    expect(net.sent).toHaveLength(1)
  })

  it('visual-check with the OpenRouter route configured sends nothing to openrouter.ai', async () => {
    const { app, net } = await worker(OR_LARGE)
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(56, 7),
    ]).toString('base64')
    await app.inject({
      method: 'POST',
      url: '/visual-check',
      headers: auth,
      payload: JSON.stringify({ pages: [png] }),
    })
    // Positive control: the page did go out, to the image-capable route.
    expect(net.sent.length).toBeGreaterThan(0)
    expect(net.sent.map((s) => s.host)).not.toContain('openrouter.ai')
    expect(new Set(net.sent.map((s) => s.host))).toEqual(
      new Set(['generativelanguage.googleapis.com']),
    )
  })
})
