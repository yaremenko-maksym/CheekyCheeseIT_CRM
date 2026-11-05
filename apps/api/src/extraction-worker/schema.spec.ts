import { describe, expect, it } from 'vitest'
import {
  EXTRACTION_TABLE_VERSION,
  MIN_WORKER_SECRET_CHARS,
  healthFlags,
  parseWorkerEnv,
  tableVersionOf,
} from './schema'
import { EXTRACTION_SYSTEM_PROMPT } from '../job-sourcing/structuring/prompt-envelope'

const SECRET = 's'.repeat(MIN_WORKER_SECRET_CHARS)
const BASE = {
  EXTRACTION_WORKER_SECRET: SECRET,
  EXTRACTION_ROUTER_CONFIG: '{"routes":[]}',
  EXTRACTION_ROUTER_STATE_FILE: '/state/route-state.json',
}

describe('parseWorkerEnv — the worker does not start without its secret', () => {
  it.each([
    ['missing', { ...BASE, EXTRACTION_WORKER_SECRET: undefined }],
    ['empty', { ...BASE, EXTRACTION_WORKER_SECRET: '' }],
    ['one short', { ...BASE, EXTRACTION_WORKER_SECRET: SECRET.slice(1) }],
  ])('secret %s: refused, the value never echoed', (_name, env) => {
    const r = parseWorkerEnv(env)
    expect(r).toEqual({ ok: false, reason: 'SECRET' })
  })

  it('a secret at the minimum length is accepted; defaults apply', () => {
    expect(MIN_WORKER_SECRET_CHARS).toBe(32)
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
    ['port too high', { ...BASE, EXTRACTION_WORKER_PORT: '65536' }, 'PORT'],
  ])('%s: refused', (_name, env, reason) => {
    expect(parseWorkerEnv(env)).toEqual({ ok: false, reason })
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
    expect(tableVersionOf(EXTRACTION_SYSTEM_PROMPT)).toBe(EXTRACTION_TABLE_VERSION)
  })

  it('changes when the prompt changes', () => {
    expect(tableVersionOf(`${EXTRACTION_SYSTEM_PROMPT} `)).not.toBe(EXTRACTION_TABLE_VERSION)
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
