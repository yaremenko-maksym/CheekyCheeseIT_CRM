import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RouterEvent } from '@crm/inference'
import { EXTRACTION_TABLE_VERSION } from './link-contract'
import { startWorker } from './start'

/** The real self-heal, with its ledger input observed (CR-M-3). */
const healed = vi.hoisted(() => ({ recorded: [] as unknown[] }))
vi.mock('./self-heal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./self-heal')>()
  return {
    ...actual,
    scheduleSelfHeal: (opts: Parameters<typeof actual.scheduleSelfHeal>[0]) => {
      const heal = actual.scheduleSelfHeal(opts)
      return {
        ...heal,
        record: (e: RouterEvent) => {
          healed.recorded.push(e)
          heal.record(e)
        },
      }
    },
  }
})

const SECRET = 'SECRET-MARKER-0123456789abcdef-0123456789'
const BEARER = { authorization: `Bearer ${SECRET}` }

/** A port that was free a moment ago; `holder` keeps it taken for the failed-listen case. */
async function takePort(): Promise<{ port: number; release(): Promise<void> }> {
  const holder = createServer()
  await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r))
  return {
    port: (holder.address() as AddressInfo).port,
    release: () => new Promise((r) => holder.close(() => r())),
  }
}

async function freePort(): Promise<number> {
  const taken = await takePort()
  await taken.release()
  return taken.port
}

function fakeProcess() {
  const out: string[] = []
  const err: string[] = []
  const exits: number[] = []
  return {
    out,
    err,
    exits,
    proc: {
      stdout: { write: (t: string) => out.push(t) },
      stderr: { write: (t: string) => err.push(t) },
      exit: (code: number) => {
        exits.push(code)
      },
    },
  }
}

const envOn = (port: number, extra: Record<string, string | undefined> = {}) => ({
  INFERENCE_EXTRACTION_PROVIDER: 'router',
  EXTRACTION_WORKER_SECRET: SECRET,
  EXTRACTION_ROUTER_CONFIG: '{"routes":[]}',
  EXTRACTION_ROUTER_STATE_FILE: join(mkdtempSync(join(tmpdir(), 'xw-start-')), 'state.json'),
  EXTRACTION_WORKER_HOST: '127.0.0.1',
  EXTRACTION_WORKER_PORT: String(port),
  ...extra,
})

const listening = (port: number) =>
  fetch(`http://127.0.0.1:${port}/extract`, { method: 'POST' }).then(
    (r) => r.status,
    () => 'REFUSED' as const,
  )

let open: { close(): Promise<unknown> }[] = []
afterEach(async () => {
  await Promise.all(open.map((a) => a.close()))
  open = []
})

describe('startWorker — a bad secret means exit 1 and no listener', () => {
  it.each([
    ['missing', undefined],
    ['too short', 'abcdefgh'],
    ['one repeated character', 's'.repeat(64)],
  ])('secret %s', async (_name, secret) => {
    const port = await freePort()
    const fake = fakeProcess()
    const app = await startWorker(envOn(port, { EXTRACTION_WORKER_SECRET: secret }), fake.proc)
    expect(app).toBeUndefined()
    expect(fake.exits).toEqual([1])
    expect(fake.err).toEqual(['extraction-worker: refusing to start, bad SECRET\n'])
    expect(fake.out).toEqual([])
    expect(await listening(port)).toBe('REFUSED')
  })

  it('a selector other than router is exit 1 by key, no listener', async () => {
    const port = await freePort()
    const fake = fakeProcess()
    const env = envOn(port, { INFERENCE_EXTRACTION_PROVIDER: 'openrouter' })
    expect(await startWorker(env, fake.proc)).toBeUndefined()
    expect(fake.exits).toEqual([1])
    expect(fake.err).toEqual(['extraction-worker: refusing to start, bad PROVIDER\n'])
    expect(await listening(port)).toBe('REFUSED')
  })
})

describe('startWorker — a good env listens', () => {
  it('serves both authenticated routes on the configured host and port; no exit', async () => {
    const port = await freePort()
    const fake = fakeProcess()
    const app = await startWorker(envOn(port), fake.proc)
    open.push(app!)
    expect(fake.exits).toEqual([])
    expect(fake.err).toEqual([])
    expect(await listening(port)).toBe(401)
    expect(fake.out.map((l) => JSON.parse(l) as unknown)).toContainEqual({
      event: 'LISTENING',
      port,
    })
    expect(fake.out.join('')).not.toContain(SECRET)
  })

  it('a listen failure is exit 1 with a fixed line, no error text', async () => {
    const taken = await takePort()
    try {
      const fake = fakeProcess()
      const app = await startWorker(envOn(taken.port), fake.proc)
      expect(app).toBeUndefined()
      expect(fake.exits).toEqual([1])
      expect(fake.err).toEqual(['extraction-worker: failed to start\n'])
    } finally {
      await taken.release()
    }
  })
})

describe('startWorker — what it wires up', () => {
  const stateFileWith = (text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'xw-start-')), 'state.json')
    writeFileSync(path, text)
    return path
  }

  const started = async (env: Record<string, string | undefined>) => {
    const fake = fakeProcess()
    const app = await startWorker(envOn(await freePort(), env), fake.proc)
    open.push(app!)
    return { app: app!, out: fake.out }
  }

  const post = (app: FastifyInstance, url: string, payload: object) =>
    app.inject({ method: 'POST', url, headers: BEARER, payload })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the state file the env names, and /extract answers from the configured routes', async () => {
    const { app } = await started({
      EXTRACTION_ROUTER_STATE_FILE: stateFileWith(
        JSON.stringify({
          version: 1,
          spent: [],
          retired: [],
          providers: [],
          modelListStale: [{ provider: 'groq', model: 'openai/gpt-oss-20b' }],
        }),
      ),
    })
    const res = await post(app, '/extract', { input: 'x', tableVersion: EXTRACTION_TABLE_VERSION })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ result: { code: string }; health: { modelListStale: boolean } }>()
    expect(body.result.code).toBe('NOT_CONFIGURED')
    expect(body.health.modelListStale).toBe(true)
  })

  it('a corrupt state file is reported on stdout as a STATE line', async () => {
    const { out } = await started({ EXTRACTION_ROUTER_STATE_FILE: stateFileWith('{ not json') })
    expect(out.map((l) => JSON.parse(l) as unknown)).toContainEqual({
      event: 'STATE',
      type: 'STATE_RESET',
      store: 'route-state',
      reason: 'invalid',
    })
  })

  describe('one start line names the hosted routes present and absent (AC12)', () => {
    const groq = {
      provider: 'groq',
      models: ['openai/gpt-oss-20b'],
      contextTokens: 8192,
      structuredOutput: 'json_object',
      minGapMs: 0,
      timeoutMs: 1000,
      maxAnswerTokens: 512,
      freeLimit: { requestsPerDay: 100 },
    }
    const env = {
      EXTRACTION_ROUTER_CONFIG: JSON.stringify({
        policyVersion: 'p1',
        hostedBudgetMs: 5000,
        routes: [groq],
      }),
    }
    const routeLines = (out: string[]) =>
      out.map((l) => JSON.parse(l) as { event: string }).filter((l) => l.event === 'HOSTED_ROUTES')

    it('the key is there: the route is present, the unconfigured one absent, and no value is logged', async () => {
      const { out } = await started({ ...env, GROQ_API_KEY: 'KEY-MARKER' })
      expect(routeLines(out)).toEqual([
        { event: 'HOSTED_ROUTES', present: ['groq'], absent: ['gemini', 'cloudflare'] },
      ])
      expect(out.join('')).not.toContain('KEY-MARKER')
    })

    it('a typo in the key name drops the route: the line shows it absent', async () => {
      const { out } = await started({ ...env, GROQ_API_KEYS: 'KEY-MARKER' })
      expect(routeLines(out)).toEqual([
        { event: 'HOSTED_ROUTES', present: [], absent: ['gemini', 'groq', 'cloudflare'] },
      ])
    })

    const cf = {
      ...groq,
      provider: 'cloudflare',
      models: ['@cf/mistralai/mistral-small-3.1-24b-instruct'],
      contextTokens: 16_000,
      maxAnswerTokens: 2_048,
      freeLimit: { requestsPerDay: 16 },
    }
    const startedWithCloudflare = (cloudflareEnv: Record<string, string>) =>
      started({
        ...env,
        EXTRACTION_ROUTER_CONFIG: JSON.stringify({
          policyVersion: 'p1',
          hostedBudgetMs: 5000,
          routes: [cf],
        }),
        ...cloudflareEnv,
      })
    const warnings = (out: string[]) =>
      out
        .map((l) => JSON.parse(l) as { event: string })
        .filter((l) => l.event === 'ROUTE_ENV_WARNING')
    const VALID_ID = '0123456789abcdef0123456789abcdef'

    it.each([
      [
        'ACCOUNT_ID_MALFORMED',
        { CLOUDFLARE_AI_TOKEN: 'KEY-MARKER', CLOUDFLARE_ACCOUNT_ID: 'ACCOUNT-MARKER' },
        ['KEY-MARKER', 'ACCOUNT-MARKER'],
      ],
      ['ACCOUNT_ID_MISSING', { CLOUDFLARE_AI_TOKEN: 'KEY-MARKER' }, ['KEY-MARKER']],
      ['TOKEN_MISSING', { CLOUDFLARE_ACCOUNT_ID: VALID_ID }, [VALID_ID]],
    ] as const)(
      '%s logs one warning naming the route and the reason, never a value',
      async (reason, cloudflareEnv, secrets) => {
        const { out } = await startedWithCloudflare(cloudflareEnv)
        expect(warnings(out)).toEqual([{ event: 'ROUTE_ENV_WARNING', route: 'cloudflare', reason }])
        expect(routeLines(out)).toEqual([
          { event: 'HOSTED_ROUTES', present: [], absent: ['gemini', 'groq', 'cloudflare'] },
        ])
        for (const secret of secrets) expect(out.join('')).not.toContain(secret)
      },
    )

    it('a config the router refuses has no route present, even one it names', async () => {
      const { out } = await started({
        EXTRACTION_ROUTER_CONFIG: JSON.stringify({ routes: [{ provider: 'groq' }] }),
        GROQ_API_KEY: 'KEY-MARKER',
      })
      expect(routeLines(out)).toEqual([
        { event: 'HOSTED_ROUTES', present: [], absent: ['gemini', 'groq', 'cloudflare'] },
      ])
    })
  })

  it('/extract spends the own cap on the hosted route only; /preflight asks no model', async () => {
    const hostnames: string[] = []
    // The router's bounded request goes through the global fetch: nothing leaves this process.
    vi.stubGlobal('fetch', (url: string) => {
      hostnames.push(new URL(url).hostname)
      return Promise.resolve(new Response('{}', { status: 500 }))
    })
    // Route parameters only: the key comes from env (ADR §2.4).
    const hosted = {
      provider: 'groq',
      models: ['openai/gpt-oss-20b'],
      contextTokens: 8192,
      structuredOutput: 'json_object',
      minGapMs: 0,
      timeoutMs: 1000,
      maxAnswerTokens: 512,
      freeLimit: { requestsPerDay: 100 },
    }
    const { app, out } = await started({
      EXTRACTION_ROUTER_CONFIG: JSON.stringify({
        policyVersion: 'p1',
        hostedBudgetMs: 5000,
        routes: [hosted],
      }),
      GROQ_API_KEY: 'KEY-MARKER',
    })

    const extract = await post(app, '/extract', {
      input: 'INPUT-MARKER page text',
      tableVersion: EXTRACTION_TABLE_VERSION,
    })
    const reply = extract.json<{ result: { code: string }; events: { type: string }[] }>()
    expect(reply.result.code).toBe('PROVIDER_ERROR')
    // No local floor (5.4c-H1): the hosted route is the only host the call reaches.
    expect(hostnames).toEqual(['api.groq.com'])
    // The wired sink (§5.3): the end of the cascade reaches both the reply and the log.
    expect(reply.events.map((e) => e.type)).toContain('CALL')
    const logged = out.map((l) => JSON.parse(l) as { event: string; type?: string })
    expect(logged).toContainEqual(expect.objectContaining({ event: 'ROUTER', type: 'CALL' }))
    // The capture (AC7): no key, secret or input text on stdout.
    for (const marker of ['KEY-MARKER', SECRET, 'INPUT-MARKER']) {
      expect(out.join('')).not.toContain(marker)
      expect(extract.body).not.toContain(marker)
    }

    hostnames.length = 0
    healed.recorded.length = 0
    const preflight = await post(app, '/preflight', {})
    // The readiness preflight (H.3) reads route state only: READY with own cap left, no request sent.
    expect(preflight.json<{ readiness: string }>().readiness).toBe('READY')
    expect(hostnames).toEqual([])
    // The preflight is not a production call: it never feeds the OK ledger.
    expect(healed.recorded).toEqual([])
  })

  it('every /extract router event feeds the self-heal OK ledger (CR-M-3, SPEC-M-1)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 500 })))
    healed.recorded.length = 0
    const { app } = await started({
      EXTRACTION_ROUTER_CONFIG: JSON.stringify({
        policyVersion: 'p1',
        hostedBudgetMs: 5000,
        routes: [
          {
            provider: 'groq',
            models: ['openai/gpt-oss-20b'],
            contextTokens: 8192,
            structuredOutput: 'json_object',
            minGapMs: 0,
            timeoutMs: 1000,
            maxAnswerTokens: 512,
            freeLimit: { requestsPerDay: 100 },
          },
        ],
      }),
      GROQ_API_KEY: 'KEY-MARKER',
    })
    const extract = await post(app, '/extract', {
      input: 'x',
      tableVersion: EXTRACTION_TABLE_VERSION,
    })
    const events = extract.json<{ events: unknown[] }>().events
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'ATTEMPT', route: 'groq', model: 'openai/gpt-oss-20b' }),
    )
    expect(healed.recorded).toEqual(events)
  })

  it('the hosted route reads the managed-list file beside the state file (ADR §3.4)', async () => {
    const models: unknown[] = []
    vi.stubGlobal('fetch', (url: string, init?: { body?: string }) => {
      if (new URL(url).hostname === 'api.groq.com') {
        models.push((JSON.parse(init?.body ?? '{}') as { model?: unknown }).model)
      }
      return Promise.resolve(new Response('{}', { status: 500 }))
    })
    const dir = mkdtempSync(join(tmpdir(), 'xw-start-'))
    writeFileSync(
      join(dir, 'managed-models.json'),
      JSON.stringify({ version: 1, providers: { groq: ['openai/gpt-oss-120b'] } }),
    )
    const { app, out } = await started({
      EXTRACTION_ROUTER_STATE_FILE: join(dir, 'state.json'),
      EXTRACTION_ROUTER_CONFIG: JSON.stringify({
        policyVersion: 'p1',
        hostedBudgetMs: 5000,
        routes: [
          {
            provider: 'groq',
            models: ['openai/gpt-oss-20b'],
            contextTokens: 8192,
            structuredOutput: 'json_object',
            minGapMs: 0,
            timeoutMs: 1000,
            maxAnswerTokens: 512,
            freeLimit: { requestsPerDay: 100 },
          },
        ],
      }),
      GROQ_API_KEY: 'KEY-MARKER',
    })
    await post(app, '/extract', { input: 'x', tableVersion: EXTRACTION_TABLE_VERSION })
    expect(models[0]).toBe('openai/gpt-oss-120b')
    // The start-up refresh ran with the state: no persisted AUTH, so nothing to clear.
    const logged = out.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(logged).toContainEqual(
      expect.objectContaining({ event: 'REFRESH', job: 'startup', provider: 'groq' }),
    )
  })
})
