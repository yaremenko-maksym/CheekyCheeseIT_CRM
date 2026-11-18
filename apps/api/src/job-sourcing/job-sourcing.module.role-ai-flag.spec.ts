import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthModule } from '../auth/auth.module'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseModule } from '../database/database.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { DatabaseService } from '../database/database.service'
import { JobSourcingModule } from './job-sourcing.module'
import { StubNotificationsModule } from './stub-notifications-module.test-helper'
import {
  RecomputeWorker,
  createRecomputeSteps,
  type RecomputeSteps,
} from './runtime/recompute-worker'

/**
 * Senior roles 4.4, owner decision 2: with `JOB_ROLE_AI_ENABLED` off, a role-`PENDING` vacancy must
 * cause NO external GET — so the detail-fetch branch must be dark. The worker's own branch on that
 * boolean is covered by `recompute-worker.spec.ts`; what this spec pins is the single line of WIRING
 * that decides the boolean, in `JobSourcingModule`'s `RecomputeWorker` factory. `*.module.ts` is on
 * the mutation gate's never-mutate list for `@crm/api`, so no gate watches that line: a flip of
 * `=== true` (or a typo in the key) would turn the flag on while the flag file still says off, and
 * nothing else in the suite would notice.
 *
 * The factory is observed through `createRecomputeSteps`, whose 4th positional parameter IS the
 * flag; the rest of the module is the real one, booted the way `job-sourcing.module.spec.ts` boots it.
 */
vi.mock('./runtime/recompute-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime/recompute-worker')>()
  return {
    ...actual,
    createRecomputeSteps: vi.fn((): RecomputeSteps => ({}) as unknown as RecomputeSteps),
  }
})

/** The flag value this boot's `ConfigService` answers with, per test. */
let flagValue: unknown = undefined
const get = vi.fn((key: string) => (key === 'JOB_ROLE_AI_ENABLED' ? flagValue : undefined))

/** Stands in for the global modules that need a database — plus a `ConfigService` that holds the flag. */
@Global()
@Module({
  providers: [
    { provide: DatabaseService, useValue: {} },
    { provide: HrAccessService, useValue: {} },
    { provide: ConfigService, useValue: { get } },
  ],
  exports: [DatabaseService, HrAccessService, ConfigService],
})
class StubGlobalsWithConfigModule {}

/** The same, with NO `ConfigService` at all: the factory injects it `optional: true`. */
@Global()
@Module({
  providers: [
    { provide: DatabaseService, useValue: {} },
    { provide: HrAccessService, useValue: {} },
  ],
  exports: [DatabaseService, HrAccessService],
})
class StubGlobalsNoConfigModule {}

@Module({})
class StubAuthModule {}

async function bootAndReadFlagArg(
  globals: typeof StubGlobalsWithConfigModule | typeof StubGlobalsNoConfigModule,
): Promise<unknown> {
  const moduleRef = await Test.createTestingModule({ imports: [JobSourcingModule, globals] })
    .overrideModule(DatabaseModule)
    .useModule(globals)
    .overrideModule(AuthModule)
    .useModule(StubAuthModule)
    .overrideModule(NotificationsModule)
    .useModule(StubNotificationsModule)
    .compile()

  // Resolving the token is what runs the factory under test.
  expect(moduleRef.get(RecomputeWorker)).toBeInstanceOf(RecomputeWorker)

  const calls = vi.mocked(createRecomputeSteps).mock.calls
  expect(calls).toHaveLength(1)
  return calls[0]?.[3]
}

describe('JobSourcingModule: the RecomputeWorker factory passes JOB_ROLE_AI_ENABLED (senior roles 4.4)', () => {
  beforeEach(() => {
    vi.mocked(createRecomputeSteps).mockClear()
    get.mockClear()
    flagValue = undefined
  })

  it('passes true when the flag is on, reading it the way its neighbours read config', async () => {
    flagValue = true

    expect(await bootAndReadFlagArg(StubGlobalsWithConfigModule)).toBe(true)
    expect(get).toHaveBeenCalledWith('JOB_ROLE_AI_ENABLED', { infer: true })
  })

  it('passes false — not undefined — when the flag is unset (owner decision 2: no external GET)', async () => {
    flagValue = undefined

    expect(await bootAndReadFlagArg(StubGlobalsWithConfigModule)).toBe(false)
  })

  it('passes false for a truthy non-true flag value, so only a real boolean true arms the fetch', async () => {
    flagValue = 'true'

    expect(await bootAndReadFlagArg(StubGlobalsWithConfigModule)).toBe(false)
  })

  it('passes false when there is no ConfigService in the container at all', async () => {
    expect(await bootAndReadFlagArg(StubGlobalsNoConfigModule)).toBe(false)
  })
})
