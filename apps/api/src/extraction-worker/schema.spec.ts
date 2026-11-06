import { routerConfigSchema } from '@crm/inference'
import { describe, expect, it } from 'vitest'
import {
  EXTRACTION_TABLE_VERSION,
  MIN_WORKER_SECRET_CHARS,
  MIN_WORKER_SECRET_DISTINCT_CHARS,
  healthFlags,
  localOnlyRouterConfig,
  parseWorkerEnv,
  tableVersionOf,
} from './schema'
import { z } from 'zod'
import { modelReplySchema } from '../job-sourcing/structuring/extraction-result-guard'
import { EXTRACTION_SYSTEM_PROMPT } from '../job-sourcing/structuring/prompt-envelope'
import { smallDoseFor } from '../job-sourcing/structuring/small-dose-table'

const MODULE = {
  prompt: EXTRACTION_SYSTEM_PROMPT,
  groups: smallDoseFor().groups,
  reply: modelReplySchema,
}

// Exactly the minimum on both axes: 32 characters, 8 distinct.
const SECRET = 'abcdefgh'.repeat(4)
const BASE = {
  INFERENCE_EXTRACTION_PROVIDER: 'router',
  EXTRACTION_WORKER_SECRET: SECRET,
  EXTRACTION_ROUTER_CONFIG: '{"routes":[]}',
  EXTRACTION_ROUTER_STATE_FILE: '/state/route-state.json',
}

describe('parseWorkerEnv — the worker does not start without its secret', () => {
  it.each([
    ['missing', { ...BASE, EXTRACTION_WORKER_SECRET: undefined }],
    ['empty', { ...BASE, EXTRACTION_WORKER_SECRET: '' }],
    ['one short', { ...BASE, EXTRACTION_WORKER_SECRET: SECRET.slice(1) }],
    ['one repeated character', { ...BASE, EXTRACTION_WORKER_SECRET: 's'.repeat(64) }],
    ['seven distinct characters', { ...BASE, EXTRACTION_WORKER_SECRET: 'abcdefg'.repeat(9) }],
  ])('secret %s: refused, the value never echoed', (_name, env) => {
    const r = parseWorkerEnv(env)
    expect(r).toEqual({ ok: false, reason: 'SECRET' })
  })

  it('a secret at the minimum length and variety is accepted; defaults apply', () => {
    expect(MIN_WORKER_SECRET_CHARS).toBe(32)
    expect(MIN_WORKER_SECRET_DISTINCT_CHARS).toBe(8)
    const r = parseWorkerEnv(BASE)
    expect(r).toEqual({
      ok: true,
      env: {
        secret: SECRET,
        routerConfig: { routes: [] },
        stateFile: '/state/route-state.json',
        host: '0.0.0.0',
        port: 3100,
      },
    })
  })

  it.each([
    ['no router config', { ...BASE, EXTRACTION_ROUTER_CONFIG: undefined }, 'ROUTER_CONFIG'],
    ['router config not JSON', { ...BASE, EXTRACTION_ROUTER_CONFIG: '{x' }, 'ROUTER_CONFIG'],
    ['no state file', { ...BASE, EXTRACTION_ROUTER_STATE_FILE: undefined }, 'STATE_FILE'],
    ['port zero', { ...BASE, EXTRACTION_WORKER_PORT: '0' }, 'PORT'],
    ['port not a number', { ...BASE, EXTRACTION_WORKER_PORT: '80a' }, 'PORT'],
    ['port with a prefix', { ...BASE, EXTRACTION_WORKER_PORT: 'x80' }, 'PORT'],
    ['port too high', { ...BASE, EXTRACTION_WORKER_PORT: '65536' }, 'PORT'],
  ])('%s: refused', (_name, env, reason) => {
    expect(parseWorkerEnv(env)).toEqual({ ok: false, reason })
  })

  it.each([
    ['no provider selector', { ...BASE, INFERENCE_EXTRACTION_PROVIDER: undefined }, 'PROVIDER'],
    ['the local selector', { ...BASE, INFERENCE_EXTRACTION_PROVIDER: 'local' }, 'PROVIDER'],
    [
      'the openrouter selector',
      { ...BASE, INFERENCE_EXTRACTION_PROVIDER: 'openrouter' },
      'PROVIDER',
    ],
    ['an empty hosted key', { ...BASE, GROQ_API_KEY: '' }, 'ROUTER_ENV'],
    ['a refused local URL', { ...BASE, ROUTER_LOCAL_MODEL_URL: 'http://10.0.0.9' }, 'ROUTER_ENV'],
  ])('%s: refused by key, the value never echoed', (_name, env, reason) => {
    const r = parseWorkerEnv(env)
    expect(r).toEqual({ ok: false, reason })
    expect(JSON.stringify(r)).not.toContain('10.0.0.9')
  })

  it('the router config takes its keys and local URL from env, never from the JSON', () => {
    const params = {
      policyVersion: 'v1',
      routes: [
        { provider: 'groq', models: ['openai/gpt-oss-20b'], apiKey: 'JSON-KEY' },
        { provider: 'local', baseUrl: 'http://evil.example' },
      ],
    }
    const r = parseWorkerEnv({
      ...BASE,
      EXTRACTION_ROUTER_CONFIG: JSON.stringify(params),
      GROQ_API_KEY: 'Q-ENV-KEY',
      ROUTER_LOCAL_MODEL_URL: 'http://crm-model-runtime:11434',
      LOCAL_MODEL_NAME: 'qwen3:8b',
    })
    expect(r.ok && r.env.routerConfig).toEqual({
      policyVersion: 'v1',
      routes: [
        { provider: 'groq', models: ['openai/gpt-oss-20b'], apiKey: 'Q-ENV-KEY' },
        { provider: 'local', baseUrl: 'http://crm-model-runtime:11434', model: 'qwen3:8b' },
      ],
    })
  })

  it('port 1 is the lowest accepted', () => {
    const r = parseWorkerEnv({ ...BASE, EXTRACTION_WORKER_PORT: '1' })
    expect(r.ok && r.env.port).toBe(1)
  })

  it('reads host and port', () => {
    const r = parseWorkerEnv({
      ...BASE,
      EXTRACTION_WORKER_HOST: '10.0.0.2',
      EXTRACTION_WORKER_PORT: '65535',
    })
    expect(r.ok && r.env.host).toBe('10.0.0.2')
    expect(r.ok && r.env.port).toBe(65535)
  })
})

describe('the table version follows the checked-in extraction module', () => {
  it('is a stable short hex digest of the current module', () => {
    expect(EXTRACTION_TABLE_VERSION).toMatch(/^[0-9a-f]{16}$/)
    expect(tableVersionOf(MODULE)).toBe(EXTRACTION_TABLE_VERSION)
  })

  it('changes when the prompt changes', () => {
    const v = tableVersionOf({ ...MODULE, prompt: `${EXTRACTION_SYSTEM_PROMPT} ` })
    expect(v).not.toBe(EXTRACTION_TABLE_VERSION)
  })

  it.each([
    ['name', { name: 'other' }],
    ['instruction', { instruction: 'other' }],
    ['answer budget', { maxAnswerTokens: 7 }],
    ['schema', { schema: z.object({ other: z.string() }) }],
  ])('changes when a group %s changes', (_name, change) => {
    const [first, ...rest] = MODULE.groups
    const groups = [{ ...first!, ...change }, ...rest]
    expect(tableVersionOf({ ...MODULE, groups })).not.toBe(EXTRACTION_TABLE_VERSION)
  })

  it('changes when the reply schema changes', () => {
    const v = tableVersionOf({ ...MODULE, reply: z.object({ other: z.string() }) })
    expect(v).not.toBe(EXTRACTION_TABLE_VERSION)
  })

  it('hashes what the caller sends, not what the parse returns', () => {
    const toNumber = tableVersionOf({ ...MODULE, reply: z.string().transform(Number) })
    const toString = tableVersionOf({ ...MODULE, reply: z.number().transform(String) })
    expect(toNumber).not.toBe(toString)
  })

  it('a schema JSON Schema cannot express does not stop the worker', () => {
    const group = { name: 'd', instruction: 'i', maxAnswerTokens: 1, schema: z.date() }
    expect(() => tableVersionOf({ prompt: 'p', groups: [group], reply: z.date() })).not.toThrow()
  })
})

describe('healthFlags', () => {
  const empty = { version: 1 as const, spent: [], retired: [], providers: [] }
  it('absent lists are clear flags', () => {
    expect(healthFlags(empty)).toEqual({ modelListStale: false, failedJobs: [] })
  })
  it('a stale entry or a failed job is raised', () => {
    expect(
      healthFlags({
        ...empty,
        modelListStale: [{ provider: 'gemini', model: 'gemini-2.5-flash' }],
        failedJobs: ['daily', 'chain'],
      }),
    ).toEqual({ modelListStale: true, failedJobs: ['daily', 'chain'] })
  })
})

describe('localOnlyRouterConfig — the preflight reaches the local route only (ADR §5.3)', () => {
  const local = {
    provider: 'local',
    baseUrl: 'http://crm-model-runtime:11434',
    model: 'qwen2.5:3b',
    contextTokens: 8192,
    structuredOutput: 'json_schema',
    timeoutMs: 1000,
    maxAnswerTokens: 512,
  }
  const hosted = {
    provider: 'groq',
    apiKey: 'KEY-MARKER',
    models: ['openai/gpt-oss-20b'],
    contextTokens: 8192,
    structuredOutput: 'json_object',
    minGapMs: 0,
    timeoutMs: 1000,
    maxAnswerTokens: 512,
    freeLimit: { requestsPerDay: 100 },
  }
  const config = {
    policyVersion: 'p1',
    hostedBudgetMs: 5000,
    floorBudgetMs: 60_000,
    routes: [hosted, local],
  }

  it('keeps the local route alone, with no hosted budget, and the router accepts it', () => {
    expect(routerConfigSchema.safeParse(config).success).toBe(true)
    const r = localOnlyRouterConfig(config)
    expect(r).toEqual({
      policyVersion: 'p1',
      hostedBudgetMs: 0,
      floorBudgetMs: 60_000,
      routes: [local],
    })
    expect(JSON.stringify(r)).not.toContain('KEY-MARKER')
    expect(routerConfigSchema.safeParse(r).success).toBe(true)
  })

  it('a config the router refuses is handed on as is, so the preflight is refused too', () => {
    const bad = { ...config, routes: [] }
    expect(localOnlyRouterConfig(bad)).toBe(bad)
  })
})
