import { routerConfigSchema } from '@crm/inference'
import { describe, expect, it } from 'vitest'
import {
  EXTRACTION_TABLE_VERSION,
  MIN_WORKER_SECRET_CHARS,
  MIN_WORKER_SECRET_DISTINCT_CHARS,
  tableVersionOf,
} from './link-contract'
import {
  healthFlags,
  MAX_WORKER_INPUT_CHARS,
  parseWorkerEnv,
  resumeWriteBodySchema,
} from './schema'
import { z } from 'zod'
import { modelReplySchema } from '../job-sourcing/structuring/extraction-result-guard'
import { EXTRACTION_SYSTEM_PROMPT } from '../job-sourcing/structuring/prompt-envelope'

const MODULE = { prompt: EXTRACTION_SYSTEM_PROMPT, reply: modelReplySchema }

// Exactly the minimum on both axes: 32 characters, 8 distinct.
const SECRET = 'abcdefgh'.repeat(4)
const BASE = {
  INFERENCE_EXTRACTION_PROVIDER: 'router',
  EXTRACTION_WORKER_SECRET: SECRET,
  EXTRACTION_ROUTER_CONFIG: '{"routes":[]}',
  EXTRACTION_ROUTER_STATE_FILE: '/state/route-state.json',
}

/**
 * The shape `writingPayload` builds (item 460). The producer itself is the positive control of
 * `resume-write.spec.ts`; here the literal is the hand-written expectation the schema is read
 * against, so a change to either side shows up as a failure rather than as agreement.
 */
const VALID_PAYLOAD = {
  headline: 'Backend engineer',
  skills: ['TypeScript'],
  yearsOfExperience: 4,
  experience: [
    {
      company: 'Acme',
      role: 'Engineer',
      start: '2021-03',
      end: null,
      current: true,
      technologies: ['Node'],
      notes: ['Built the billing service'],
    },
  ],
}
const ITEM = VALID_PAYLOAD.experience[0]!
const PAYLOAD = JSON.stringify(VALID_PAYLOAD)

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
        routeWarnings: [],
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
  ])('%s: refused by key, the value never echoed', (_name, env, reason) => {
    const r = parseWorkerEnv(env)
    expect(r).toEqual({ ok: false, reason })
  })

  it('a stale local URL is no worker key any more (5.4c-H1): not read, not refused', () => {
    const r = parseWorkerEnv({ ...BASE, ROUTER_LOCAL_MODEL_URL: 'http://10.0.0.9' })
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r)).not.toContain('10.0.0.9')
  })

  it('the router config takes its keys from env, never from the JSON; a stale local route goes on for the router to refuse', () => {
    const params = {
      policyVersion: 'v1',
      routes: [
        { provider: 'groq', models: ['openai/gpt-oss-20b'], apiKey: 'JSON-KEY' },
        { provider: 'local', contextTokens: 8192 },
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
        { provider: 'local', contextTokens: 8192 },
      ],
    })
    expect(routerConfigSchema.safeParse(r.ok && r.env.routerConfig).success).toBe(false)
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
    expect(() => tableVersionOf({ prompt: 'p', reply: z.date() })).not.toThrow()
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

describe('resumeWriteBodySchema — an oversize field stops at its first violation', () => {
  const codes = (extra: Record<string, unknown>) => {
    const r = resumeWriteBodySchema.safeParse({
      task: 'summary',
      payload: PAYLOAD,
      feedback: [],
      ...extra,
    })
    return r.success ? [] : r.error.issues.map((i) => i.code)
  }

  it('an oversize non-JSON payload is refused by its size alone: the JSON check does not run', () => {
    expect(codes({ payload: 'x'.repeat(MAX_WORKER_INPUT_CHARS + 1) })).toEqual(['too_big'])
  })

  it('an oversize feedback line with a line break is refused by its size alone', () => {
    expect(codes({ feedback: [`${'f'.repeat(1000)}\n`] })).toEqual(['too_big'])
  })

  it('a non-JSON payload within the size is still refused by the JSON check', () => {
    expect(codes({ payload: 'not json' })).toEqual(['custom'])
  })
})

describe('resumeWriteBodySchema — `payload` is a WritingPayload and nothing else (item 460)', () => {
  const accepts = (payload: string) =>
    resumeWriteBodySchema.safeParse({ task: 'summary', payload, feedback: [] }).success
  const acceptsValue = (payload: unknown) => accepts(JSON.stringify(payload))
  const without = (o: Record<string, unknown>, key: string) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => k !== key))

  it('the shape the producer builds is accepted', () => {
    expect(accepts(PAYLOAD)).toBe(true)
  })

  it('an empty experience list is accepted: a resume with no job yet still gets a summary', () => {
    expect(acceptsValue({ ...VALID_PAYLOAD, experience: [] })).toBe(true)
  })

  it('no field length bound: a headline far over any field cap is accepted', () => {
    expect(acceptsValue({ ...VALID_PAYLOAD, headline: 'x'.repeat(10_000) })).toBe(true)
  })

  it.each([
    ['name', { name: 'Jane Doe' }],
    ['email', { email: 'jane@example.com' }],
    ['phone', { phone: '+380 50 123 4567' }],
    ['link', { link: 'https://example.com/jane' }],
    ['location', { location: { city: 'Lisbon' } }],
    ['education', { education: [] }],
  ])('an unknown top-level key (%s) is refused', (_name, extra) => {
    expect(acceptsValue({ ...VALID_PAYLOAD, ...extra })).toBe(false)
  })

  it.each([
    ['email', { email: 'jane@example.com' }],
    ['link', { link: 'https://example.com/jane' }],
    ['location', { location: 'Lisbon' }],
    ['dates', { dates: '2021-2024' }],
  ])('an unknown key inside an experience item (%s) is refused', (_name, extra) => {
    expect(acceptsValue({ ...VALID_PAYLOAD, experience: [{ ...ITEM, ...extra }] })).toBe(false)
  })

  it('a `__proto__` key is refused: JSON.parse makes it an own key of the payload', () => {
    const raw = '{"__proto__":{"email":"jane@example.com"},' + PAYLOAD.slice(1)
    expect(accepts(raw)).toBe(false)
  })

  it.each(['headline', 'skills', 'yearsOfExperience', 'experience'])(
    'a payload missing `%s` is refused',
    (key) => {
      expect(acceptsValue(without(VALID_PAYLOAD, key))).toBe(false)
    },
  )

  it.each(['company', 'role', 'start', 'end', 'current', 'technologies', 'notes'])(
    'an experience item missing `%s` is refused',
    (key) => {
      expect(acceptsValue({ ...VALID_PAYLOAD, experience: [without(ITEM, key)] })).toBe(false)
    },
  )

  it.each([
    ['headline as a number', { headline: 1 }],
    ['skills as a string', { skills: 'TypeScript' }],
    ['a skill as a number', { skills: [1] }],
    ['yearsOfExperience as a string', { yearsOfExperience: '4' }],
    ['a fractional yearsOfExperience', { yearsOfExperience: 4.5 }],
    ['a negative yearsOfExperience', { yearsOfExperience: -1 }],
    ['experience as an object', { experience: {} }],
  ])('a mistyped top-level field (%s) is refused', (_name, extra) => {
    expect(acceptsValue({ ...VALID_PAYLOAD, ...extra })).toBe(false)
  })

  it.each([
    ['company as a number', { company: 1 }],
    ['role as null', { role: null }],
    ['start as a number', { start: 2021 }],
    ['end as a number', { end: 2024 }],
    ['current as a string', { current: 'true' }],
    ['technologies as a string', { technologies: 'Node' }],
    ['notes as a string', { notes: 'Built the billing service' }],
  ])('a mistyped experience field (%s) is refused', (_name, extra) => {
    expect(acceptsValue({ ...VALID_PAYLOAD, experience: [{ ...ITEM, ...extra }] })).toBe(false)
  })

  it('a null start and end are accepted: a draft job may have neither', () => {
    const experience = [{ ...ITEM, start: null, end: null }]
    expect(acceptsValue({ ...VALID_PAYLOAD, experience })).toBe(true)
  })
})
