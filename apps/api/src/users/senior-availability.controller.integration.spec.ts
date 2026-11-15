/**
 * HTTP-level RBAC for GET / PUT `/api/users/:id/availability` (PR #1337 SR-L-1): the REAL guard
 * chain (JwtAuthGuard cookie → OnboardingGuard → the controller's RolesGuard + `@Roles`), the
 * real controller and service, a real DB. Complements `senior-availability-rbac.integration.spec.ts`,
 * which drives the service directly. Pattern: `legends.controller.integration.spec.ts`.
 *
 * Seed rows are namespaced `savail-http-` and deleted in afterAll. NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run senior-availability.controller.integration.spec
 */
import { Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { OnboardingGuard } from '../auth/onboarding.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import { users } from '../database/schema'
import { OnboardingService } from '../onboarding/onboarding.service'
import { hasDatabaseUrl } from '../test/require-real-db'
import { ZodExceptionFilter } from '../zod-exception.filter'
import { AuditLogService } from './audit-log.service'
import { SeniorAvailabilityController } from './senior-availability.controller'
import { SeniorAvailabilityService } from './senior-availability.service'

const JWT_SECRET = 'test-senior-availability-http-secret-xx'
const ID = {
  admin: '5a110015-0000-4000-bb00-0000000000a1',
  senA: '5a110015-0000-4000-bb00-0000000000a2',
  senB: '5a110015-0000-4000-bb00-0000000000a3',
  hr: '5a110015-0000-4000-bb00-0000000000a4',
  junior: '5a110015-0000-4000-bb00-0000000000a5',
} as const
const SEEDED = Object.values(ID)
const FREE = { status: 'FREE', availableFrom: '2026-12-01' } as const

const session = (id: string, role: SessionUser['role']): SessionUser => ({
  id,
  email: `savail-http-${id}@test.spec`,
  displayName: role,
  avatarUrl: null,
  role,
  seniorSharePercent: 26,
})

const onboarding = { getStatus: vi.fn() }
const ONBOARDED = {
  requiresContract: false,
  requiresTos: false,
  contractTemplate: null,
  tosVersion: null,
  tosUpdateAvailable: false,
  latestTosVersion: null,
}

describe.skipIf(!hasDatabaseUrl())('SeniorAvailabilityController — real guard chain (HTTP)', () => {
  let pool: Pool
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const { rows } = await pool.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    const db = drizzle(pool, { schema })
    // a plain object, not DatabaseService.prototype: Nest would run its onModuleInit (a 2nd pool)
    const dbSvc = { pool, db } as unknown as DatabaseService

    await db.delete(users).where(inArray(users.id, SEEDED))
    await db.insert(users).values([
      { id: ID.admin, email: `savail-http-${ID.admin}@test.spec`, displayName: 'a', role: 'ADMIN' },
      { id: ID.senA, email: `savail-http-${ID.senA}@test.spec`, displayName: 's', role: 'SENIOR' },
      { id: ID.senB, email: `savail-http-${ID.senB}@test.spec`, displayName: 's', role: 'SENIOR' },
      { id: ID.hr, email: `savail-http-${ID.hr}@test.spec`, displayName: 'h', role: 'HR' },
      {
        id: ID.junior,
        email: `savail-http-${ID.junior}@test.spec`,
        displayName: 'j',
        role: 'JUNIOR',
      },
    ])

    @Module({
      imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
      controllers: [SeniorAvailabilityController],
      providers: [
        Reflector,
        {
          provide: SeniorAvailabilityService,
          useValue: new SeniorAvailabilityService(dbSvc, new AuditLogService(dbSvc)),
        },
        { provide: OnboardingService, useValue: onboarding },
        {
          provide: APP_GUARD,
          useFactory: (j: JwtService, r: Reflector) => new JwtAuthGuard(j, r),
          inject: [JwtService, Reflector],
        },
        {
          provide: APP_GUARD,
          useFactory: (svc: OnboardingService) => new OnboardingGuard(svc),
          inject: [OnboardingService],
        },
      ],
    })
    class TestModule {}

    // the real RolesGuard, built explicitly: vitest emits no decorator metadata for its Reflector
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] })
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'test-senior-availability-cookie-secret' })
    app.setGlobalPrefix('api')
    app.useGlobalFilters(new ZodExceptionFilter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    jwt = moduleRef.get(JwtService)
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    await pool?.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [SEEDED])
    await pool?.end()
  })

  beforeEach(() => {
    onboarding.getStatus.mockResolvedValue(ONBOARDED)
  })

  const call = (method: 'GET' | 'PUT', target: string, as?: SessionUser, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/users/${target}/availability`,
      ...(as ? { cookies: { jwt: jwt.sign(as) } } : {}),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    })

  it('no cookie: 401', async () => {
    expect((await call('GET', ID.senA)).statusCode).toBe(401)
    expect((await call('PUT', ID.senA, undefined, FREE)).statusCode).toBe(401)
  })

  it('SENIOR → self: PUT 200 echoes the value, GET 200 reads it back', async () => {
    const me = session(ID.senA, 'SENIOR')
    const put = await call('PUT', ID.senA, me, FREE)
    expect(put.statusCode).toBe(200)
    expect(put.json()).toEqual(FREE)
    const get = await call('GET', ID.senA, me)
    expect(get.statusCode).toBe(200)
    expect(get.json()).toEqual(FREE)
  })

  it('ADMIN → a senior: 200', async () => {
    const res = await call('PUT', ID.senB, session(ID.admin, 'ADMIN'), { status: 'BUSY' })
    expect(res.statusCode).toBe(200)
  })

  it.each([
    ['HR', session(ID.hr, 'HR')],
    ['JUNIOR', session(ID.junior, 'JUNIOR')],
  ])('%s (refused by @Roles): 403 on GET and PUT, even with a bad body', async (_r, as) => {
    expect((await call('GET', ID.senA, as)).statusCode).toBe(403)
    expect((await call('PUT', ID.senA, as, { status: 'BUSY' })).statusCode).toBe(403)
    expect((await call('PUT', ID.senA, as, { status: 'AWAY' })).statusCode).toBe(403)
  })

  it('SENIOR → another senior (refused by the service): 403, the value is unchanged', async () => {
    const other = session(ID.senB, 'SENIOR')
    expect((await call('PUT', ID.senA, other, { status: 'BUSY' })).statusCode).toBe(403)
    expect((await call('GET', ID.senA, other)).statusCode).toBe(403)
    expect((await call('GET', ID.senA, session(ID.senA, 'SENIOR'))).json()).toEqual(FREE)
  })

  it('a malformed body from an allowed viewer: 400', async () => {
    const res = await call('PUT', ID.senA, session(ID.senA, 'SENIOR'), { status: 'FREE' })
    expect(res.statusCode).toBe(400)
  })

  it('a non-UUID id: 400 from ParseUUIDPipe', async () => {
    expect((await call('GET', 'not-a-uuid', session(ID.senA, 'SENIOR'))).statusCode).toBe(400)
  })

  it('a SENIOR who has not finished onboarding: 403 ONBOARDING_REQUIRED', async () => {
    onboarding.getStatus.mockResolvedValue({ ...ONBOARDED, requiresTos: true })
    const res = await call('GET', ID.senA, session(ID.senA, 'SENIOR'))
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error?: string }).error).toBe('ONBOARDING_REQUIRED')
  })
})
