/**
 * task-i18n-stage2 (Task 3, Step 5) — real-Postgres integration spec.
 *
 * WHY this test exists (feedback_mocked_e2e_guards lesson): a unit test on
 * `UsersService.updateProfile`/`createUser` in isolation cannot prove the
 * ROUND TRIP — that a value written through one HTTP handler is the same
 * value another handler reads back, through the REAL `sessionUserSchema`
 * parse + REAL Drizzle row shape. This spec stands up sentinel HTTP
 * endpoints (same pattern as `salary-meta.integration.spec.ts` /
 * `documents-unified.integration.spec.ts` — `useFactory` DI to dodge the
 * esbuild decorator-metadata issue with class-token providers) mirroring
 * `PATCH /users/me`, `GET /auth/me`, `POST /users`, wired to the REAL
 * `UsersService` against the REAL database. Collaborators `UsersService`
 * never calls on these three paths (`UsersAccessService`, `TosService`,
 * `TeamAuditLogService`, `ProjectAuditLogService`, `TeamsService`) are typed
 * stubs — see the per-stub comments below for why each is safe to fake here.
 */
import { Body, Controller, Get, Inject, Module, Patch, Post } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createUserSchema,
  sessionUserSchema,
  updateProfileSchema,
  type SessionUser,
} from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { DatabaseService } from '../database/database.service'
import { ZodExceptionFilter } from '../zod-exception.filter'
import { UsersService } from './users.service'
import { AuditLogService } from './audit-log.service'
import { UsersAccessService } from './users-access.service'
import { TosService } from '../tos/tos.service'
import { TeamAuditLogService } from '../teams/team-audit-log.service'
import { ProjectAuditLogService } from '../projects/project-audit-log.service'
import { TeamsService } from '../teams/teams.service'
import { PersonalEmailInviteMailerService } from './personal-email-invite-mailer.service'
import { users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

const JWT_SECRET = 'users-locale-integration-secret-32-chars-x'

/** Unique per test run so re-runs never collide on the `users.email` unique index. */
const TEST_TAG = `users-locale-spec-${Date.now()}`
const JUNIOR_ID = '90000001-0000-4000-a000-000000000001'
const ADMIN_ID = '90000001-0000-4000-a000-000000000002'
// SR-M-2: a UUID deliberately NOT seeded into `users` — used to pin that the
// real guard chain (see the APP_GUARD factory's own comment above) rejects a
// structurally valid token for a row that does not exist.
const NONEXISTENT_ID = '90000001-0000-4000-a000-00000000dead'

let _testPool: Pool | undefined

/**
 * Real `DatabaseService` connected to `DATABASE_URL` — same construction
 * technique as `documents-unified.integration.spec.ts`'s `TestDatabaseModule`
 * (bypasses the constructor's own `ConfigService` dependency; DI would need
 * a full `ConfigModule` for one field).
 */
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        _testPool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        const db = drizzle(_testPool, { schema })
        const instance = Object.create(DatabaseService.prototype) as DatabaseService
        Object.assign(instance, { pool: _testPool, db })
        Object.defineProperty(instance, 'onModuleInit', {
          value: () => Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => _testPool?.end() ?? Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        return instance
      },
    },
  ],
  exports: [DatabaseService],
})
class TestDatabaseModule {}

// `createUser`/`updateProfile`/`findById` — the three methods this spec
// exercises — never call any of these five collaborators (verified by
// reading `users.service.ts`: `accessService`/`tosService` are only reached
// from `buildProfileView`; `teamAuditLogService`/`projectAuditLogService`
// only from role/team-mutation methods; `teamsService` only from the
// SENIOR + JOIN_DROP_TEAM branch, unreached by a JUNIOR create below).
const accessServiceStub = {} as unknown as UsersAccessService
const tosServiceStub = {} as unknown as TosService
const teamAuditLogServiceStub = {} as unknown as TeamAuditLogService
const projectAuditLogServiceStub = {} as unknown as ProjectAuditLogService
const teamsServiceStub = {} as unknown as TeamsService
// `createUser` DOES call `auditLogService.record` unconditionally
// (`profile_created` audit event) — stubbed to a no-op rather than the real
// service so this spec never writes to `user_audit_log` (nothing here reads
// it back; a no-op keeps cleanup to just the `users` row).
const auditLogServiceStub = { record: () => Promise.resolve() } as unknown as AuditLogService
// Only reached when `data.personalEmail` is set — never set below.
const inviteMailerStub = {
  sendInvite: () => Promise.resolve(true),
} as unknown as PersonalEmailInviteMailerService

// String token, not the class itself: controller constructor params rely on
// `design:paramtypes` reflection metadata, which esbuild (vitest's
// transformer) strips — same issue `documents-unified.integration.spec.ts`'s
// own doc names for `SentinelDocumentsController`. Plain class-based
// injection silently resolves to `undefined` here instead of throwing.
const USERS_SERVICE_TOKEN = 'USERS_SERVICE_TOKEN'

/** Mirrors `PATCH /users/me`, `GET /auth/me`, `POST /users` — see file doc. */
@Controller()
class SentinelController {
  constructor(@Inject(USERS_SERVICE_TOKEN) private readonly usersService: UsersService) {}

  @Patch('users/me')
  async updateMe(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const dto = updateProfileSchema.parse(body)
    return this.usersService.updateProfile(user.id, dto)
  }

  /** Same two-branch shape as `AuthController.me` — the fresh-row branch only
   * (the fallback-to-JWT branch is unreachable here: `findById` never
   * returns undefined for a row this spec itself just inserted). */
  @Get('auth/me')
  async me(@CurrentUser() user: SessionUser) {
    const fresh = await this.usersService.findById(user.id)
    if (!fresh) throw new Error('unreachable in this spec')
    return sessionUserSchema.parse({
      id: fresh.id,
      email: fresh.email,
      displayName: fresh.displayName,
      avatarUrl: fresh.avatarUrl ?? null,
      avatarDocumentId: fresh.avatarDocumentId ?? null,
      role: fresh.role,
      seniorSharePercent: fresh.seniorSharePercent,
      locale: fresh.locale,
      legalFullName: fresh.legalFullName ?? null,
      impersonating: false,
    })
  }

  @Post('users')
  async createUser(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const dto = createUserSchema.parse(body)
    return this.usersService.createUser({
      email: dto.email,
      displayName: dto.displayName,
      role: dto.role,
      paymentMethod: dto.paymentMethod,
      bankUahRecipient: dto.bankUahRecipient,
      bankUahIban: dto.bankUahIban,
      bankUahRnokpp: dto.bankUahRnokpp,
      legalFullName: dto.legalFullName,
      ...(dto.locale !== undefined && { locale: dto.locale }),
      actorRole: user.role,
      actorId: user.id,
    })
  }
}

@Module({
  imports: [TestDatabaseModule, JwtModule.register({ secret: JWT_SECRET })],
  controllers: [SentinelController],
  providers: [
    Reflector,
    {
      provide: UsersService,
      useFactory: (db: DatabaseService) =>
        new UsersService(
          db,
          accessServiceStub,
          auditLogServiceStub,
          tosServiceStub,
          teamAuditLogServiceStub,
          projectAuditLogServiceStub,
          teamsServiceStub,
          inviteMailerStub,
        ),
      inject: [DatabaseService],
    },
    // String token alias — `SentinelController` uses `@Inject(token)` to
    // bypass the esbuild metadata issue on controller constructor params.
    {
      provide: USERS_SERVICE_TOKEN,
      useExisting: UsersService,
    },
    // SR-M-2 (security-review PR #693 round 1): the guard MUST be constructed
    // with the REAL `UsersService` (the same instance the module above wires
    // up against the real DB), not `new JwtAuthGuard(jwt, reflector)` alone.
    // The two-arg form takes the `!this.usersService` branch of
    // `resolveCurrentUser` (see that method's own doc in jwt.guard.ts) —
    // "direct-construction only, unreachable in the running app" — which
    // skips role/archivedAt re-hydration AND (per this file's own header)
    // is exactly the shape `feedback_mocked_e2e_guards` warns against: a
    // token signed for an id that does not exist in `users` at all sailed
    // through as if it were a real session. Passing the real service here is
    // what makes the file's own "REAL guard chain" claim true.
    {
      provide: APP_GUARD,
      useFactory: (jwt: JwtService, reflector: Reflector, usersService: UsersService) =>
        new JwtAuthGuard(jwt, reflector, usersService),
      inject: [JwtService, Reflector, UsersService],
    },
  ],
})
class UsersLocaleTestModule {}

describe.skipIf(!hasDatabaseUrl())(
  'users.locale round trip — PATCH /users/me, GET /auth/me, POST /users (Task 3, Step 5)',
  () => {
    let app: NestFastifyApplication
    let jwt: JwtService
    let db: ReturnType<typeof drizzle<typeof schema>>

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [UsersLocaleTestModule],
      }).compile()

      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'users-locale-integration-cookie-secret-32c' })
      app.useGlobalFilters(new ZodExceptionFilter())
      app.setGlobalPrefix('api')
      await app.init()
      await app.getHttpAdapter().getInstance().ready()

      jwt = moduleRef.get(JwtService)
      const dbSvc = moduleRef.get(DatabaseService)
      db = dbSvc.db

      // Seed the JUNIOR row this suite patches/reads — locale defaults to
      // 'uk' via the column default (not set explicitly, so the FIRST test
      // below also pins that default end-to-end).
      await db
        .insert(users)
        .values({
          id: JUNIOR_ID,
          email: `${TEST_TAG}-junior@test.spec`,
          displayName: 'Locale Junior',
          role: 'JUNIOR',
        })
        .onConflictDoNothing()
      // SR-M-2: the ADMIN token below now goes through the REAL guard chain
      // (see the APP_GUARD factory's comment) — it must resolve to an
      // actual `users` row, or the "new users default to uk" test would 401
      // before ever reaching the handler.
      await db
        .insert(users)
        .values({
          id: ADMIN_ID,
          email: `${TEST_TAG}-admin@test.spec`,
          displayName: 'Locale Admin',
          role: 'ADMIN',
        })
        .onConflictDoNothing()
    }, 30_000)

    afterAll(async () => {
      // ON DELETE CASCADE on `user_emails.user_id` — deleting `users` rows
      // is sufficient cleanup (also covers rows POST /users inserted).
      await db.delete(users).where(eq(users.email, `${TEST_TAG}-junior@test.spec`))
      await db.delete(users).where(eq(users.email, `${TEST_TAG}-admin@test.spec`))
      await db.delete(users).where(eq(users.email, `${TEST_TAG}-created@test.spec`))
      // Defensive: the 401 test above should never let this row exist, but
      // clean it up unconditionally so a failing assertion there doesn't
      // also leave a stray row behind for the next run.
      await db.delete(users).where(eq(users.email, `${TEST_TAG}-should-not-be-created@test.spec`))
      await app.close()
      // Pool torn down by the factory-registered onModuleDestroy.
    }, 15_000)

    function tokenFor(id: string, role: 'JUNIOR' | 'ADMIN'): string {
      return jwt.sign({ id, email: `${id}@test.spec`, role })
    }

    it('GET /auth/me reflects the column default (uk) before any PATCH', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { jwt: tokenFor(JUNIOR_ID, 'JUNIOR') },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().locale).toBe('uk')
    })

    it('PATCH /users/me {locale:"en"} is reflected by GET /auth/me', async () => {
      const patchRes = await app.inject({
        method: 'PATCH',
        url: '/api/users/me',
        cookies: { jwt: tokenFor(JUNIOR_ID, 'JUNIOR') },
        payload: { locale: 'en' },
      })
      expect(patchRes.statusCode).toBe(200)

      const meRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { jwt: tokenFor(JUNIOR_ID, 'JUNIOR') },
      })
      expect(meRes.statusCode).toBe(200)
      expect(meRes.json().locale).toBe('en')
    })

    it('rejects an unsupported locale with 400 via ZodExceptionFilter', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/users/me',
        cookies: { jwt: tokenFor(JUNIOR_ID, 'JUNIOR') },
        payload: { locale: 'ru' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('new users default to uk when the create wizard omits locale', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users',
        cookies: { jwt: tokenFor(ADMIN_ID, 'ADMIN') },
        payload: {
          email: `${TEST_TAG}-created@test.spec`,
          displayName: 'Locale Created',
          role: 'JUNIOR',
          paymentMethod: 'BANK_UAH_FOP',
          bankUahRecipient: 'Тестов Тест',
          bankUahIban: 'UA123456789012345678901234567',
          bankUahRnokpp: '1234567890',
          // JUNIOR is a CONTRACT_ROLES member in createUserSchema's
          // superRefine — required, or the whole payload 400s before
          // `locale` is ever reached.
          legalFullName: 'Тестов Тест Тестович',
        },
      })
      expect(res.statusCode).toBe(201)
      expect(res.json().locale).toBe('uk')
    })

    // SR-M-2 (security-review PR #693 round 1): with `new JwtAuthGuard(jwt,
    // reflector)` (no `usersService`), a structurally valid token signed for
    // an id that does not exist in `users` at all sailed through with a 201
    // — this is the exact gap `feedback_mocked_e2e_guards` warns about. With
    // the real guard chain (APP_GUARD factory above), the SAME token must be
    // rejected before the handler runs at all.
    it('rejects a token for a user id that does not exist in the DB with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users',
        cookies: { jwt: tokenFor(NONEXISTENT_ID, 'ADMIN') },
        payload: {
          email: `${TEST_TAG}-should-not-be-created@test.spec`,
          displayName: 'Should Not Exist',
          role: 'JUNIOR',
          paymentMethod: 'BANK_UAH_FOP',
          bankUahRecipient: 'Тестов Тест',
          bankUahIban: 'UA123456789012345678901234567',
          bankUahRnokpp: '1234567890',
          legalFullName: 'Тестов Тест Тестович',
        },
      })
      expect(res.statusCode).toBe(401)
    })
  },
)
