import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXTRACTION_TABLE_VERSION } from './schema'
import { startWorker } from './start'

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

  it('/extract spends the own cap on the hosted route, then the floor; /preflight is local only', async () => {
    const hostnames: string[] = []
    // The router's bounded request goes through the global fetch: nothing leaves this process.
    vi.stubGlobal('fetch', (url: string) => {
      hostnames.push(new URL(url).hostname)
      return Promise.resolve(new Response('{}', { status: 500 }))
    })
    // Route parameters only: the key, the local URL and the local model come from env (ADR §2.4).
    const local = {
      provider: 'local',
      contextTokens: 8192,
      structuredOutput: 'json_schema',
      timeoutMs: 1000,
      maxAnswerTokens: 512,
    }
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
    const { app } = await started({
      EXTRACTION_ROUTER_CONFIG: JSON.stringify({
        policyVersion: 'p1',
        hostedBudgetMs: 5000,
        floorBudgetMs: 60_000,
        routes: [hosted, local],
      }),
      GROQ_API_KEY: 'KEY-MARKER',
      ROUTER_LOCAL_MODEL_URL: 'http://crm-model-runtime:11434',
      LOCAL_MODEL_NAME: 'qwen2.5:3b',
    })

    const extract = await post(app, '/extract', {
      input: 'x',
      tableVersion: EXTRACTION_TABLE_VERSION,
    })
    expect(extract.json<{ result: { code: string } }>().result.code).toBe('PROVIDER_ERROR')
    expect(hostnames).toEqual(['api.groq.com', 'crm-model-runtime'])

    hostnames.length = 0
    const preflight = await post(app, '/preflight', {})
    expect(preflight.json<{ ok: boolean }>().ok).toBe(false)
    expect(hostnames).toEqual(['crm-model-runtime'])
  })
})
