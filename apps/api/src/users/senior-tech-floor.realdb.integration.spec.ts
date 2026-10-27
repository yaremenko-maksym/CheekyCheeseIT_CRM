/**
 * SENIOR technology floor (>= 3 distinct technologies) — real-backend spec.
 *
 * Real `UsersController` + the real guard chain (`JwtAuthGuard` as APP_GUARD,
 * the controller's own `RolesGuard`) + the real `UsersService` on real Postgres.
 * Every write path that can create a SENIOR, turn a user into one, or change a
 * SENIOR's stack is driven over HTTP, and each refusal is checked against the
 * database: the refusal is only worth anything if nothing was written.
 *
 * Paths: POST /users (ADMIN, HR), PATCH /users/:id (ADMIN), PATCH /users/:id/role
 * (ADMIN), PATCH /users/me (the SENIOR themself). A role that may not reach a
 * route gets its 403 before any validation runs.
 *
 * DB-SKIP-GUARD: `describe.skipIf(!hasDatabaseUrl())` — SKIPPED without
 * DATABASE_URL; a set-but-unusable DATABASE_URL fails `beforeAll` loudly.
 */
import { Global, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray, like } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { AuditInterceptor } from '../common/interceptors/audit.interceptor'
import { DatabaseService } from '../database/database.service'
import {
  teamAuditLog,
  teamMembers,
  teams,
  userAuditLog,
  userEmails,
  users,
} from '../database/schema'
import * as schema from '../database/schema'
import { makeNotificationsStub } from '../notifications/__test-helpers__/notifications-stub'
import { ProjectAuditLogService } from '../projects/project-audit-log.service'
import { TeamAuditLogService } from '../teams/team-audit-log.service'
import { TeamsService } from '../teams/teams.service'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import { AuditLogService } from './audit-log.service'
import { PersonalEmailInviteMailerService } from './personal-email-invite-mailer.service'
import { UsersAccessService } from './users-access.service'
import { UsersController } from './users.controller'
import { UsersService } from './users.service'

const JWT_SECRET = 'senior-tech-floor-realdb-integration-secret'
const EMAIL_PREFIX = 'stf-'
const EMAIL_DOMAIN = '@test.spec'

type Role = 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT'
interface Persona {
  id: string
  email: string
  role: Role
  techStack?: string[] | null
}

// Fixed personas, namespaced to this spec (`5f5f…` = "stf").
const ADMIN: Persona = {
  id: '5f5f0000-0000-4000-aa00-000000000001',
  email: 'stf-admin@test.spec',
  role: 'ADMIN',
}
const HR: Persona = {
  id: '5f5f0000-0000-4000-aa00-000000000002',
  email: 'stf-hr@test.spec',
  role: 'HR',
}
const JUNIOR: Persona = {
  id: '5f5f0000-0000-4000-aa00-000000000003',
  email: 'stf-junior@test.spec',
  role: 'JUNIOR',
  techStack: ['React', 'Go'],
}
const ACCOUNTANT: Persona = {
  id: '5f5f0000-0000-4000-aa00-000000000004',
  email: 'stf-acc@test.spec',
  role: 'ACCOUNTANT',
}
const SENIOR3: Persona = {
  id: '5f5f0000-0000-4000-aa00-000000000005',
  email: 'stf-senior3@test.spec',
  role: 'SENIOR',
  techStack: ['React', 'Go', 'AWS'],
}
const LEGACY2: Persona = {
  id: '5f5f0000-0000-4000-aa00-000000000006',
  email: 'stf-legacy2@test.spec',
  role: 'SENIOR',
  techStack: ['React', 'Go'],
}
const LEGACY1: Persona = {
  id: '5f5f0000-0000-4000-aa00-000000000007',
  email: 'stf-legacy1@test.spec',
  role: 'SENIOR',
  techStack: ['React'],
}
const SELF3: Persona = {
  id: '5f5f0000-0000-4000-aa00-000000000008',
  email: 'stf-self3@test.spec',
  role: 'SENIOR',
  techStack: ['React', 'Go', 'AWS'],
}
const PERSONAS = [ADMIN, HR, JUNIOR, ACCOUNTANT, SENIOR3, LEGACY2, LEGACY1, SELF3]

const WALLET = '0x' + '1'.repeat(40)
const BELOW = [[], ['React'], ['React', 'Go'], ['a', 'a', 'a'], ['node', 'Node.js', 'Go']]

let pool: Pool | null = null

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        const instance = Object.create(DatabaseService.prototype) as DatabaseService
        Object.assign(instance, { pool, db: drizzle(pool, { schema }) })
        // The real hooks read ConfigService; this pool is owned by the spec.
        Object.defineProperty(instance, 'onModuleInit', { value: () => Promise.resolve() })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => pool?.end() ?? Promise.resolve(),
        })
        return instance
      },
    },
  ],
  exports: [DatabaseService],
})
class TestDatabaseModule {}

function buildUsersService(db: DatabaseService): UsersService {
  const teamAuditLogService = new TeamAuditLogService(db)
  const teamsService = new TeamsService(
    db,
    {} as never,
    teamAuditLogService,
    makeNotificationsStub(),
  )
  const usersService = new UsersService(
    db,
    {} as never,
    new AuditLogService(db),
    {} as never,
    teamAuditLogService,
    new ProjectAuditLogService(db),
    teamsService,
    {} as never,
    { getStatus: async () => 'NONE' as const } as never,
    makeNotificationsStub(),
  )
  ;(teamsService as unknown as { usersService: UsersService }).usersService = usersService
  return usersService
}

@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
  ],
  controllers: [UsersController],
  providers: [
    Reflector,
    { provide: UsersService, useFactory: buildUsersService, inject: [DatabaseService] },
    {
      provide: AuditLogService,
      useFactory: (db: DatabaseService) => new AuditLogService(db),
      inject: [DatabaseService],
    },
    { provide: UsersAccessService, useValue: {} },
    { provide: PersonalEmailInviteMailerService, useValue: { sendInvite: async () => undefined } },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector, usersService: UsersService) =>
        new JwtAuthGuard(jwtSvc, reflector, usersService),
      inject: [JwtService, Reflector, UsersService],
    },
  ],
})
class SeniorTechFloorTestModule {}

describe.skipIf(!hasDatabaseUrl())(
  'SENIOR technology floor — real backend (real DB, real guards)',
  () => {
    let app: NestFastifyApplication
    let jwt: JwtService
    let db: DatabaseService['db']

    const tokenFor = (p: Persona) => jwt.sign({ id: p.id, email: p.email, role: p.role })
    const call = async (method: 'POST' | 'PATCH', url: string, as: Persona, payload: object) => {
      const res = await app.inject({ method, url, cookies: { jwt: tokenFor(as) }, payload })
      const body = res.body ? (res.json() as { code?: string }) : {}
      return { status: res.statusCode, code: body.code }
    }
    const rowByEmail = (email: string) =>
      db.query.users.findFirst({ where: eq(users.email, email) })
    const rowById = (id: string) => db.query.users.findFirst({ where: eq(users.id, id) })

    async function wipe(): Promise<void> {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(like(users.email, `${EMAIL_PREFIX}%${EMAIL_DOMAIN}`))
      const ids = rows.map((r) => r.id)
      if (ids.length === 0) return
      const teamRows = await db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(inArray(teamMembers.userId, ids))
      const teamIds = [...new Set(teamRows.map((r) => r.teamId))]
      if (teamIds.length > 0) {
        await db.delete(teamAuditLog).where(inArray(teamAuditLog.targetId, teamIds))
        await db.delete(teamMembers).where(inArray(teamMembers.teamId, teamIds))
        await db.delete(teams).where(inArray(teams.id, teamIds))
      }
      await db.delete(userAuditLog).where(inArray(userAuditLog.targetId, ids))
      await db.delete(userAuditLog).where(inArray(userAuditLog.actorId, ids))
      await db.delete(userEmails).where(inArray(userEmails.userId, ids))
      await db.delete(users).where(inArray(users.id, ids))
    }

    beforeAll(async () => {
      await assertRealDbSchema([{ table: 'users', column: 'tech_stack' }])
      const moduleRef = await Test.createTestingModule({ imports: [SeniorTechFloorTestModule] })
        .overrideGuard(RolesGuard)
        .useValue(new RolesGuard(new Reflector()))
        .overrideInterceptor(AuditInterceptor)
        .useValue({ intercept: (_c: unknown, next: { handle: () => unknown }) => next.handle() })
        .compile()
      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'senior-tech-floor-cookie-secret' })
      app.setGlobalPrefix('api')
      await app.init()
      await app.getHttpAdapter().getInstance().ready()
      jwt = moduleRef.get(JwtService)
      const usersService = moduleRef.get(UsersService)
      // vitest/esbuild strips constructor param metadata — wire the controller by hand.
      Object.assign(app.get(UsersController), {
        usersService,
        auditLogService: moduleRef.get(AuditLogService),
        accessService: {},
        inviteMailer: { sendInvite: async () => undefined },
      })
      db = moduleRef.get(DatabaseService).db

      await wipe()
      await db.insert(users).values(
        PERSONAS.map((p) => ({
          id: p.id,
          email: p.email,
          displayName: `STF ${p.role}`,
          role: p.role,
          techStack: p.techStack ?? null,
          googleId: `stf-google-${p.id}`,
        })),
      )
    })

    afterAll(async () => {
      if (db) await wipe()
      if (app) await app.close()
    })

    const adminSeniorBody = (email: string, techStack: string[]) => ({
      email,
      displayName: 'STF New Senior',
      role: 'SENIOR',
      legalFullName: 'Тестовий Сеньйор Іванович',
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: WALLET,
      techStack,
    })
    const hrSeniorBody = (email: string, techStack: string[]) => ({
      email,
      displayName: 'STF HR Senior',
      role: 'SENIOR',
      hrIds: [HR.id],
      techStack,
    })

    describe('POST /users — create a SENIOR', () => {
      it.each([JUNIOR, ACCOUNTANT, SENIOR3])('$role gets 403 before any validation', async (p) => {
        const email = `${EMAIL_PREFIX}forbidden-${p.role.toLowerCase()}${EMAIL_DOMAIN}`
        expect(await call('POST', '/api/users', p, adminSeniorBody(email, []))).toMatchObject({
          status: 403,
        })
        expect(await rowByEmail(email)).toBeUndefined()
      })

      it('HR asking for a non-SENIOR role gets 403 HR_SENIOR_ONLY_CREATION, not the floor error', async () => {
        const email = `${EMAIL_PREFIX}hr-junior${EMAIL_DOMAIN}`
        const res = await call('POST', '/api/users', HR, {
          ...hrSeniorBody(email, []),
          role: 'JUNIOR',
        })
        expect(res).toEqual({ status: 403, code: 'HR_SENIOR_ONLY_CREATION' })
      })

      for (const [actor, body] of [
        [ADMIN, adminSeniorBody],
        [HR, hrSeniorBody],
      ] as const) {
        it(`${actor.role}: 0, 1, 2 distinct technologies -> 400 SENIOR_MIN_TECHNOLOGIES, no user row`, async () => {
          for (const [i, techStack] of BELOW.entries()) {
            const email = `${EMAIL_PREFIX}${actor.role.toLowerCase()}-below-${i}${EMAIL_DOMAIN}`
            expect(await call('POST', '/api/users', actor, body(email, techStack))).toEqual({
              status: 400,
              code: 'SENIOR_MIN_TECHNOLOGIES',
            })
            expect(await rowByEmail(email)).toBeUndefined()
          }
        })

        it(`${actor.role}: exactly 3 technologies -> 201 and the stack is stored`, async () => {
          const email = `${EMAIL_PREFIX}${actor.role.toLowerCase()}-ok${EMAIL_DOMAIN}`
          expect(
            (await call('POST', '/api/users', actor, body(email, ['React', 'Go', 'AWS']))).status,
          ).toBe(201)
          expect(await rowByEmail(email)).toMatchObject({
            role: 'SENIOR',
            techStack: ['React', 'Go', 'AWS'],
          })
        })
      }
    })

    describe('PATCH /users/:id — admin edit', () => {
      it('HR gets 403 (ADMIN only) before any validation', async () => {
        expect(
          await call('PATCH', `/api/users/${SENIOR3.id}`, HR, { techStack: ['React'] }),
        ).toMatchObject({ status: 403 })
      })

      it('SENIOR 3 -> 2 is refused and the stored stack is unchanged', async () => {
        expect(
          await call('PATCH', `/api/users/${SENIOR3.id}`, ADMIN, { techStack: ['React', 'Go'] }),
        ).toEqual({ status: 400, code: 'SENIOR_MIN_TECHNOLOGIES' })
        expect((await rowById(SENIOR3.id))?.techStack).toEqual(['React', 'Go', 'AWS'])
      })

      it('SENIOR 3 -> 4 is written', async () => {
        const next = ['React', 'Go', 'AWS', 'Docker']
        expect(
          (await call('PATCH', `/api/users/${SENIOR3.id}`, ADMIN, { techStack: next })).status,
        ).toBe(200)
        expect((await rowById(SENIOR3.id))?.techStack).toEqual(next)
      })

      it('a legacy SENIOR with 2 technologies: an unrelated edit succeeds (A1)', async () => {
        expect(
          (await call('PATCH', `/api/users/${LEGACY2.id}`, ADMIN, { displayName: 'STF Renamed' }))
            .status,
        ).toBe(200)
        expect(await rowById(LEGACY2.id)).toMatchObject({
          displayName: 'STF Renamed',
          techStack: ['React', 'Go'],
        })
      })

      it('JUNIOR with 2 technologies promoted to SENIOR here is refused; the role is unchanged', async () => {
        expect(await call('PATCH', `/api/users/${JUNIOR.id}`, ADMIN, { role: 'SENIOR' })).toEqual({
          status: 400,
          code: 'SENIOR_MIN_TECHNOLOGIES',
        })
        expect((await rowById(JUNIOR.id))?.role).toBe('JUNIOR')
      })
    })

    describe('PATCH /users/:id/role', () => {
      it('JUNIOR with 2 technologies -> SENIOR is refused; the role is unchanged', async () => {
        expect(
          await call('PATCH', `/api/users/${JUNIOR.id}/role`, ADMIN, { role: 'SENIOR' }),
        ).toEqual({
          status: 400,
          code: 'SENIOR_MIN_TECHNOLOGIES',
        })
        expect((await rowById(JUNIOR.id))?.role).toBe('JUNIOR')
      })

      it('a SENIOR with 1 technology -> JUNIOR is unaffected', async () => {
        expect(
          (await call('PATCH', `/api/users/${LEGACY1.id}/role`, ADMIN, { role: 'JUNIOR' })).status,
        ).toBe(200)
        expect((await rowById(LEGACY1.id))?.role).toBe('JUNIOR')
      })
    })

    describe('PATCH /users/me — the SENIOR edits their own stack', () => {
      it('3 -> 2 is refused and nothing is written', async () => {
        expect(
          await call('PATCH', '/api/users/me', SELF3, { techStack: ['React', 'React', 'Go'] }),
        ).toEqual({
          status: 400,
          code: 'SENIOR_MIN_TECHNOLOGIES',
        })
        expect((await rowById(SELF3.id))?.techStack).toEqual(['React', 'Go', 'AWS'])
      })

      it('3 -> 4 is written', async () => {
        const next = ['React', 'Go', 'AWS', 'Rust']
        expect((await call('PATCH', '/api/users/me', SELF3, { techStack: next })).status).toBe(200)
        expect((await rowById(SELF3.id))?.techStack).toEqual(next)
      })

      it('a JUNIOR may keep a single technology', async () => {
        expect(
          (await call('PATCH', '/api/users/me', JUNIOR, { techStack: ['React'] })).status,
        ).toBe(200)
        expect((await rowById(JUNIOR.id))?.techStack).toEqual(['React'])
      })
    })
  },
)
