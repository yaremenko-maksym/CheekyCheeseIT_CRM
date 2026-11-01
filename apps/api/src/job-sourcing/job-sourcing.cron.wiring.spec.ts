import { Global, Module, type OnModuleInit } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { AuthModule } from '../auth/auth.module'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseModule } from '../database/database.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { DatabaseService } from '../database/database.service'
import { JobSourcingCronService } from './job-sourcing.cron'
import { JobSourcingModule } from './job-sourcing.module'
import { StubNotificationsModule } from './stub-notifications-module.test-helper'

/**
 * r5 Task 2.5 T5 — the REAL container hands the cron service the REAL ledger, worker and config.
 * The three are `@Optional()` (a unit context builds the service without them), so a missing
 * provider would not fail at boot: the handlers would quietly collect DOU only. Here the 02:30
 * handler runs against the booted module and its ledger statements are read off the database stub.
 */
const dialect = new PgDialect()
const statements: string[] = []
const execute = vi.fn(async (query: SQL) => {
  const text = dialect.sqlToQuery(query).sql
  statements.push(text)
  if (text.includes('INSERT INTO job_collection_cycles')) {
    return { rows: [{ id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }] }
  }
  if (text.includes('count(*)')) return { rows: [{ n: 0 }] }
  return { rows: [] }
})
const transaction = vi.fn(async (cb: (tx: unknown) => unknown) => cb({ execute }))

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

describe('JobSourcingCronService, booted', () => {
  it('runs the ledger steps of the 02:30 handler through the injected ledger, window from config', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JOB_COLLECTION_WINDOW_MS: 1_234 })],
        }),
        JobSourcingModule,
        StubGlobalsModule,
      ],
    })
      .overrideModule(DatabaseModule)
      .useModule(StubGlobalsModule)
      .overrideModule(AuthModule)
      .useModule(StubAuthModule)
      .overrideModule(NotificationsModule)
      .useModule(StubNotificationsModule)
      .compile()
    await moduleRef.init()

    const cron = moduleRef.get(JobSourcingCronService)
    expect((cron as unknown as { windowMs(): number }).windowMs()).toBe(1_234)
    await cron.handleHtmlCollection()

    const has = (needle: string) => statements.some((s) => s.includes(needle))
    expect(has('INSERT INTO job_collection_cycles')).toBe(true) // openCycle
    expect(has('lease_expires_at')).toBe(true) // recoverExpired reads candidates
    expect(has("SET status = 'CLOSED'")).toBe(true) // the window closed its cycle
    await moduleRef.close()
  })
})
