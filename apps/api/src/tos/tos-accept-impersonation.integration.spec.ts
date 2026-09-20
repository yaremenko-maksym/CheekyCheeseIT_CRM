/**
 * `POST /api/tos/accept` under impersonation — task-680 fix-round 3, SR-M-3.
 *
 * Same shape as `notification-preferences.rbac.integration.spec.ts`'s own
 * "имперсонация" block (backlog 205) — a REAL `TosController`, behind the
 * REAL `JwtAuthGuard` chain, against a REAL Postgres. Why HTTP and not a
 * direct service call: "замоканная спека ничего не знает про глобальные
 * guard'ы" (`.claude/skills/security-review`, паттерн 4; инцидент #110) —
 * this is exactly the axis `tos.controller.spec.ts` (the controller unit
 * double) cannot cover, since it constructs the controller directly and
 * never goes through `JwtAuthGuard`'s payload → `request.user` resolution.
 *
 * Deliberately narrow: this file exists ONLY to prove the impersonation
 * guard end-to-end (403 + zero `tos_acceptances` rows). The full RBAC
 * matrix for `/tos/accept` (any authenticated role, onboarding bypass) is
 * out of scope here and already exercised elsewhere
 * (`onboarding-contract.integration.spec.ts`, `tos.service.spec.ts`).
 */
import { Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import { tosAcceptances, tosVersions, users } from '../database/schema'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import { ZodExceptionFilter } from '../zod-exception.filter'
import { TosController } from './tos.controller'
import { TosService } from './tos.service'
import { TosPdfService } from './tos-pdf.service'

const JWT_SECRET = 'tos-accept-impersonation-secret-32-chars'

type Role = 'ADMIN' | 'SENIOR'
interface Persona {
  id: string
  email: string
  role: Role
}

// Пространство идентификаторов: f7b20000-**-4008-b**-**
const ADMIN: Persona = {
  id: 'f7b20000-0000-4008-b000-000000000001',
  email: 'ta-admin@test.spec',
  role: 'ADMIN',
}
const SENIOR: Persona = {
  id: 'f7b20000-0000-4008-b000-000000000002',
  email: 'ta-senior@test.spec',
  role: 'SENIOR',
}
const ALL_IDS = [ADMIN.id, SENIOR.id]

const ROLE_ROWS = new Map<string, { role: Role; archivedAt: Date | null }>([
  [ADMIN.id, { role: ADMIN.role, archivedAt: null }],
  [SENIOR.id, { role: SENIOR.role, archivedAt: null }],
])
const usersServiceStub = { findById: (id: string) => Promise.resolve(ROLE_ROWS.get(id)) }

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
  controllers: [TosController],
  providers: [
    Reflector,
    // `accept` never touches TosPdfService — a no-op stub is enough.
    { provide: TosPdfService, useValue: {} },
    // `TosService` is wired by hand after `app.init()` (see beforeAll) — the
    // esbuild/vite DI gap. A placeholder provider keeps Nest's constructor
    // resolution happy in the meantime.
    { provide: TosService, useValue: {} },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) =>
        new JwtAuthGuard(jwtSvc, reflector, usersServiceStub as never),
      inject: [JwtService, Reflector],
    },
  ],
})
class TosAcceptImpersonationTestModule {}

describe.skipIf(!hasDatabaseUrl())('POST /tos/accept под имперсонацией (SR-M-3)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let pool: Pool
  let db: ReturnType<typeof drizzle<typeof schema>>
  let tosVersionId: string
  // `tos_versions` carries a partial UNIQUE index on `is_active = true` — a
  // shared scratch DB (seeded per `.claude/rules/common/live-db-access.md`)
  // can already have one active row. Restore it in afterAll instead of
  // assuming there is none, mirroring what `TosService.publish` itself does
  // atomically (deactivate-then-insert) rather than a blind INSERT.
  let previousActiveVersionId: string | null = null

  beforeAll(async () => {
    await assertRealDbSchema([{ table: 'tos_acceptances', column: 'tos_version_id' }])

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    db = drizzle(pool, { schema })
    const dbService = { db } as unknown as DatabaseService
    const tosService = new TosService(dbService)

    await db.delete(tosAcceptances).where(inArray(tosAcceptances.userId, ALL_IDS))
    await db.delete(users).where(inArray(users.id, ALL_IDS))
    await db.insert(users).values([
      { id: ADMIN.id, email: ADMIN.email, displayName: 'ADMIN', role: ADMIN.role },
      { id: SENIOR.id, email: SENIOR.email, displayName: 'SENIOR', role: SENIOR.role },
    ])

    const activeBefore = await db.query.tosVersions.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.isActive, true),
    })
    previousActiveVersionId = activeBefore?.id ?? null

    const published = await tosService.publish({
      bodyMarkdown: '# Terms (task-680 fix-round 3, SR-M-3)',
      createdByUserId: ADMIN.id,
    })
    tosVersionId = published.id

    const moduleRef = await Test.createTestingModule({
      imports: [TosAcceptImpersonationTestModule],
    })
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'tos-accept-impersonation-cookie-secret' })
    app.setGlobalPrefix('api')
    app.useGlobalFilters(new ZodExceptionFilter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    jwt = moduleRef.get(JwtService)

    // esbuild/vite omit `design:paramtypes` — wire the REAL service by hand,
    // same pattern as `notification-preferences.rbac.integration.spec.ts`.
    Object.assign(app.get(TosController), { service: tosService })
  }, 30_000)

  afterAll(async () => {
    await db.delete(tosAcceptances).where(inArray(tosAcceptances.userId, ALL_IDS))
    await db.delete(tosVersions).where(eq(tosVersions.id, tosVersionId))
    if (previousActiveVersionId) {
      await db
        .update(tosVersions)
        .set({ isActive: true })
        .where(eq(tosVersions.id, previousActiveVersionId))
    }
    await db.delete(users).where(inArray(users.id, ALL_IDS))
    await app.close()
    await pool.end()
  })

  afterEach(async () => {
    await db.delete(tosAcceptances).where(inArray(tosAcceptances.userId, ALL_IDS))
  })

  const tokenFor = (p: Persona) => jwt.sign({ id: p.id, email: p.email, role: p.role })
  const tokenForImpersonated = (target: Persona, impersonatorId: string) =>
    jwt.sign({ id: target.id, email: target.email, role: target.role, impersonatorId })

  it('под имперсонацией — 403 с кодом TOS_ACCEPT_IMPERSONATION, строка в tos_acceptances не создаётся (task-i18n-stage2-task5)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tos/accept',
      cookies: { jwt: tokenForImpersonated(SENIOR, ADMIN.id) },
    })

    expect(res.statusCode).toBe(403)
    const body = res.json<{ statusCode: number; code: string }>()
    expect(body.statusCode).toBe(403)
    expect(body.code).toBe('TOS_ACCEPT_IMPERSONATION')

    const rows = await db.select().from(tosAcceptances).where(eq(tosAcceptances.userId, SENIOR.id))
    expect(rows).toHaveLength(0)
  })

  it('без имперсонации тот же запрос — 200, строка создаётся', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tos/accept',
      cookies: { jwt: tokenFor(SENIOR) },
    })

    expect(res.statusCode).toBe(200)

    const rows = await db.select().from(tosAcceptances).where(eq(tosAcceptances.userId, SENIOR.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tosVersionId).toBe(tosVersionId)
  })
})
