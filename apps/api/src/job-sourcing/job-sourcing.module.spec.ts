import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { describe, expect, it } from 'vitest'
import { AuthModule } from '../auth/auth.module'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseModule } from '../database/database.module'
import { DatabaseService } from '../database/database.service'
import { DouRssProvider } from './dou.provider'
import { JobSourcingModule } from './job-sourcing.module'
import { JobSourcingService } from './job-sourcing.service'
import { JobSourceRegistry } from './registry/job-source-registry'

/** Stands in for the global modules that need a database; everything else is the REAL module. */
@Global()
@Module({
  providers: [
    { provide: DatabaseService, useValue: {} },
    { provide: HrAccessService, useValue: {} },
  ],
  exports: [DatabaseService, HrAccessService],
})
class StubGlobalsModule {}

@Module({})
class StubAuthModule {}

describe('JobSourcingModule wiring (the path production uses)', () => {
  it('resolves JobSourcingService with the module-provided registry holding DOU and nothing else', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JobSourcingModule, StubGlobalsModule],
    })
      .overrideModule(DatabaseModule)
      .useModule(StubGlobalsModule)
      .overrideModule(AuthModule)
      .useModule(StubAuthModule)
      .compile()

    const registry = moduleRef.get(JobSourceRegistry)
    const service = moduleRef.get(JobSourcingService) as unknown as { registry: JobSourceRegistry }

    expect(service.registry).toBe(registry)
    expect(registry.types()).toEqual(['DOU_RSS'])
    expect(registry.get('DOU_RSS')?.contract).toBe('LEGACY')
    expect(registry.legacyProvider('DOU_RSS')).toBe(moduleRef.get(DouRssProvider))
  })
})
