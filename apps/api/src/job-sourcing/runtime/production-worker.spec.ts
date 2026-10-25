import type { ConfigService } from '@nestjs/config'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../config/env'
import type { MeterDb } from '../metering/account-meter.store'
import { secretsForType } from '../quota-credentials'
import { JobSourceRegistry } from '../registry/job-source-registry'
import { POOL_SIZE_CEILING } from './job-run-worker'
import { createProductionWorker } from './production-worker'

/**
 * r5 Task 2.5 T7 — the production wiring: the worker builds without touching anything (the module
 * constructs it at boot), and the types' credentials become the run's secrets.
 */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('the database was touched')
    },
  },
) as MeterDb

describe('createProductionWorker', () => {
  it('builds with no database contact and no config, and closes cleanly having opened nothing', async () => {
    const w = createProductionWorker(untouchable, new JobSourceRegistry([]), undefined)
    expect(w.options).toMatchObject({ owner: `api-${process.pid}`, poolSize: 2 })
    await expect(w.onModuleDestroy()).resolves.toBeUndefined()
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

  it('reads credentials through the config it was given', () => {
    const config = {
      get: (key: string) =>
        key === 'JSEARCH_API_KEY' || key === 'RAPIDAPI_KEY' ? 'rapid-key-1' : undefined,
    } as unknown as ConfigService<Env, true>
    expect(createProductionWorker(untouchable, new JobSourceRegistry([]), config)).toBeDefined()
  })
})

describe('secretsForType (T7: quota-credentials feeds secrets)', () => {
  const read = (key: string) =>
    ({ RAPIDAPI_KEY: 'rapid-key-1', THEIRSTACK_API_KEY: 'ts-key-1' })[key]

  it('a keyed type contributes its own key', () => {
    expect(secretsForType('JSEARCH_API', read)).toEqual(['rapid-key-1'])
    expect(secretsForType('THEIRSTACK_API', read)).toEqual(['ts-key-1'])
  })

  it('a keyed type with no key, a keyless provider and an unkeyed type contribute nothing', () => {
    expect(secretsForType('JOOBLE_API', read)).toEqual([])
    expect(secretsForType('MUSE_API', read)).toEqual([])
    expect(secretsForType('REMOTIVE_API', read)).toEqual([])
  })
})
