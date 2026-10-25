import type { ConfigService } from '@nestjs/config'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../config/env'
import type { MeterDb } from '../metering/account-meter.store'
import { secretsForType } from '../quota-credentials'
import { JobSourceRegistry } from '../registry/job-source-registry'
import { POOL_SIZE_CEILING, type WorkerDeps } from './job-run-worker'
import { createProductionWorker } from './production-worker'

/**
 * r5 Task 2.5 T7 — the production wiring: the worker builds without touching anything (the module
 * constructs it at boot), the types' credentials become the run's secrets, and the heartbeat's
 * reserved pool is opened on first use and released at shutdown.
 */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('the database was touched')
    },
  },
) as MeterDb

/** Nothing listens on port 1: a query fails fast instead of reaching any real database. */
const config = {
  get: (key: string) =>
    ({
      DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none',
      RAPIDAPI_KEY: 'rapid-key-1',
    })[key],
} as unknown as ConfigService<Env, true>

const depsOf = (w: unknown) => (w as { deps: WorkerDeps }).deps

const HANDLE = {
  runId: '00000000-0000-4000-8000-000000000001',
  ownerToken: 'api-1:x',
  fencingEpoch: 1,
}

describe('createProductionWorker', () => {
  it('builds with no database contact and no config, and closes cleanly having opened nothing', async () => {
    const w = createProductionWorker(untouchable, new JobSourceRegistry([]), undefined)
    expect(w.options).toMatchObject({ owner: `api-${process.pid}`, poolSize: 2 })
    await expect(w.onModuleDestroy()).resolves.toBeUndefined()
  })

  it('without config it refuses to run, by name', () => {
    const w = createProductionWorker(untouchable, new JobSourceRegistry([]), undefined)
    expect(() => depsOf(w).secretsFor('JSEARCH_API')).toThrow(
      'the run worker needs ConfigService to run',
    )
  })

  it('passes worker options through, under their ceilings', () => {
    const w = createProductionWorker(untouchable, new JobSourceRegistry([]), undefined, {
      poolSize: POOL_SIZE_CEILING,
    })
    expect(w.options.poolSize).toBe(POOL_SIZE_CEILING)
    expect(() =>
      createProductionWorker(untouchable, new JobSourceRegistry([]), undefined, {
        poolSize: POOL_SIZE_CEILING + 1,
      }),
    ).toThrow(/poolSize/)
  })

  it('reads the type`s credentials through the config it was given', () => {
    const w = createProductionWorker(untouchable, new JobSourceRegistry([]), config)
    expect(depsOf(w).secretsFor('JSEARCH_API')).toEqual(['rapid-key-1'])
    expect(depsOf(w).secretsFor('REMOTIVE_API')).toEqual([])
  })

  it('heartbeats through the ledger on its own pool, opened on first use and ended at shutdown', async () => {
    const w = createProductionWorker(untouchable, new JobSourceRegistry([]), config)
    // a malformed handle owns nothing: the ledger answers false before any SQL
    await expect(depsOf(w).heartbeat({ ...HANDLE, runId: 'nope' })).resolves.toBe(false)
    await w.onModuleDestroy()
    // the reserved pool was ended: a well-formed heartbeat now fails on the ended pool
    const error = await depsOf(w)
      .heartbeat(HANDLE)
      .catch((e: unknown) => e)
    expect(String((error as { cause?: unknown }).cause)).toMatch(/after calling end/)
  })
})

describe('secretsForType (T7: quota-credentials feeds secrets)', () => {
  const KEYS: Record<string, string> = {
    JOOBLE_API_KEY: 'jooble-key-1',
    RAPIDAPI_KEY: 'rapid-key-1',
    THEIRSTACK_API_KEY: 'ts-key-1',
    REED_API_KEY: 'reed-key-1',
  }
  /** Refuses any key it does not know, so a wrong mapping cannot read past it. */
  const read = (key: string) => {
    if (!(key in KEYS)) throw new Error(`unexpected key ${String(key)}`)
    return KEYS[key]
  }

  it.each([
    ['JOOBLE_API', ['jooble-key-1']],
    ['JSEARCH_API', ['rapid-key-1']],
    ['THEIRSTACK_API', ['ts-key-1']],
    ['REED_API', ['reed-key-1']],
  ] as const)('%s contributes its own key', (type, secrets) => {
    expect(secretsForType(type, read)).toEqual(secrets)
  })

  it('a keyless provider and an unkeyed type contribute nothing and read no key', () => {
    const none = () => {
      throw new Error('no key may be read')
    }
    expect(secretsForType('MUSE_API', none)).toEqual([])
    expect(secretsForType('REMOTIVE_API', none)).toEqual([])
  })

  it('a keyed type with no key configured contributes nothing', () => {
    expect(secretsForType('JOOBLE_API', () => undefined)).toEqual([])
  })
})
