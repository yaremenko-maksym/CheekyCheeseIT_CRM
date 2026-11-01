import { Global, Module, NotFoundException, type OnModuleInit } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { SessionUser } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'
import { AuthModule } from '../auth/auth.module'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseModule } from '../database/database.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { DatabaseService } from '../database/database.service'
import { JobSourceAdminService } from './admin/job-source-admin.service'
import { JobSourcingModule } from './job-sourcing.module'
import { StubNotificationsModule } from './stub-notifications-module.test-helper'
import { JobRunWorker } from './runtime/job-run-worker'
import { RecomputeWorker } from './runtime/recompute-worker'

/**
 * r5 Task 2.5 T7 — the REAL `JobSourcingModule` container, with a database service that behaves
 * like the real one: its `db` exists only after `onModuleInit` (the pool is opened there). The run
 * ledger and the worker are built by factories BEFORE that hook runs, so a factory that captures
 * `databaseService.db` captures `undefined`. Hand-built services in the other specs cannot see this;
 * here the admin service and the worker are taken from the container and actually called.
 *
 * (Regression: PR #1162 head 39b5fc36d answered the admin reset with a 500,
 * "Cannot read properties of undefined (reading 'transaction')".)
 */
const transaction = vi.fn(async (cb: (tx: unknown) => unknown) =>
  cb({ execute: async () => ({ rows: [] }) }),
)
const execute = vi.fn(async () => ({ rows: [] }))

class LateDatabaseService implements OnModuleInit {
  db: unknown = undefined

  onModuleInit(): void {
    this.db = { transaction, execute }
  }
}

@Global()
@Module({
  providers: [
    { provide: DatabaseService, useClass: LateDatabaseService },
    { provide: HrAccessService, useValue: {} },
  ],
  exports: [DatabaseService, HrAccessService],
})
class StubGlobalsModule {}

@Module({})
class StubAuthModule {}

const ADMIN = { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', role: 'ADMIN' } as SessionUser

describe('JobSourcingModule, booted: the ledger reaches the database the app opens at init', () => {
  it('the admin reset goes through the injected ledger to the initialised database', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JobSourcingModule, StubGlobalsModule],
    })
      .overrideModule(DatabaseModule)
      .useModule(StubGlobalsModule)
      .overrideModule(AuthModule)
      .useModule(StubAuthModule)
      .overrideModule(NotificationsModule)
      .useModule(StubNotificationsModule)
      .compile()
    await moduleRef.init()

    const admin = moduleRef.get(JobSourceAdminService)
    await expect(
      admin.resetFailures('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', { reason: 'fixed' }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(transaction).toHaveBeenCalledTimes(1)

    // the worker's ledger is the same container's: its start-up recovery reads the database too
    await expect(moduleRef.get(JobRunWorker).start()).resolves.toBe(0)
    expect(execute).toHaveBeenCalled()

    // Task 4.6 S4a: the recompute worker claims through the same initialised database.
    execute.mockClear()
    await expect(moduleRef.get(RecomputeWorker).runOnce()).resolves.toEqual({
      claimed: 0,
      done: 0,
      deferred: 0,
      retried: 0,
      failed: 0,
      fenced: 0,
    })
    expect(execute).toHaveBeenCalledTimes(1)
    await moduleRef.close()
  })
})
