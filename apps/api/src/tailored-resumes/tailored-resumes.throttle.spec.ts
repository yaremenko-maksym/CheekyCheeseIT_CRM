import { type CanActivate, type ExecutionContext, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { ThrottlerModule } from '@nestjs/throttler'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RolesGuard } from '../common/guards/roles.guard'
import { UserAwareThrottlerGuard } from '../common/guards/user-aware-throttler.guard'
import { TailoredResumesController } from './tailored-resumes.controller'
import { TailoredResumesService } from './tailored-resumes.service'

/**
 * The per-route throttle of the tailored writes (plan Task 12): the real controller behind the
 * app's own `UserAwareThrottlerGuard`, a global ceiling far above the route's, a fresh in-memory
 * store per test. No database: the service is a stub.
 */
const OPP = '0b5e0000-0000-4000-8000-0000000000a1'
const S1 = '0b5e0000-0000-4000-8000-000000000001'
const RUN = '0b5e0000-0000-4000-8000-0000000000e1'
const RENDER = '0b5e0000-0000-4000-8000-0000000000f1'
const EDIT = {
  summary: 'Backend engineer.',
  skills: ['TypeScript'],
  bullets: [['Built the billing API.']],
  coverLetter: 'I would like to apply.',
}

class AsHr implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest<Record<string, unknown>>()['user'] = {
      id: '0b5e0000-0000-4000-8000-0000000000b1',
      role: 'HR',
    }
    return true
  }
}

let app: NestFastifyApplication

beforeEach(async () => {
  delete process.env.THROTTLE_RELAXED
  const service = {
    generate: vi.fn(async () => ({ runId: RUN })),
    edit: vi.fn(async () => ({ renderId: RENDER })),
  }
  @Module({
    imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 1000 }])],
    controllers: [TailoredResumesController],
    providers: [
      Reflector,
      { provide: TailoredResumesService, useValue: service },
      { provide: ConfigService, useValue: { get: () => true } },
      { provide: APP_GUARD, useFactory: () => new AsHr() },
      { provide: APP_GUARD, useClass: UserAwareThrottlerGuard },
    ],
  })
  class ThrottleModule {}
  const moduleRef = await Test.createTestingModule({ imports: [ThrottleModule] })
    .overrideGuard(RolesGuard)
    .useValue(new RolesGuard(new Reflector()))
    .compile()
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  app.setGlobalPrefix('api')
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
})

afterEach(async () => {
  await app.close()
})

async function statuses(method: 'POST' | 'PUT', payload: object, count: number) {
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const res = await app.inject({
      method,
      url: `/api/job-queue/${OPP}/seniors/${S1}/tailored`,
      payload,
    })
    out.push(res.statusCode)
  }
  return out
}

describe('tailored writes throttle: 10 per 60 s per user', () => {
  it('the 11th POST in 60 s → 429', async () => {
    expect(await statuses('POST', { overwrite: false }, 11)).toEqual([...Array(10).fill(202), 429])
  })

  it('the 11th PUT in 60 s → 429', async () => {
    expect(await statuses('PUT', EDIT, 11)).toEqual([...Array(10).fill(202), 429])
  })
})
