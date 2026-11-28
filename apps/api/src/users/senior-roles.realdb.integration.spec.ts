/**
 * Senior technical roles (senior roles PR 2, Task 2.4) — real-backend spec.
 *
 * Real `UsersController` + the real guard chain (`JwtAuthGuard` as APP_GUARD, the controller's own
 * `RolesGuard`) + the real `UsersService` on real Postgres, the same harness as
 * `senior-tech-floor.realdb.integration.spec.ts`. RBAC is unchanged by this PR: whoever may edit a
 * senior's stack today may edit their roles. Every refusal is checked against the database.
 *
 * Paths: PATCH /users/:id (ADMIN), POST /users (ADMIN, HR), PATCH /users/me (self).
 *
 * DB-SKIP-GUARD: `describe.skipIf(!hasDatabaseUrl())` — SKIPPED without DATABASE_URL; a
 * set-but-unusable DATABASE_URL fails `beforeAll` loudly.
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { AuditInterceptor } from '../common/interceptors/audit.interceptor'
import { DatabaseService } from '../database/database.service'
import {
  jobDirtyWork,
  seniorResumes,
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
import { ZodExceptionFilter } from '../zod-exception.filter'

const JWT_SECRET = 'senior-roles-realdb-integration-secret-32c'
const EMAIL_PREFIX = 'srr-'
const EMAIL_DOMAIN = '@test.spec'

type Role = 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR'
interface Persona {
  id: string
  email: string
  role: Role
  techStack?: string[] | null
  technicalRoles?: string[]
}

// Fixed personas, namespaced to this spec (`5e70…` = "senior roles").
const ADMIN: Persona = {
  id: '5e700000-0000-4000-aa00-000000000001',
  email: 'srr-admin@test.spec',
  role: 'ADMIN',
}
const HR: Persona = {
  id: '5e700000-0000-4000-aa00-000000000002',
  email: 'srr-hr@test.spec',
  role: 'HR',
}
const JUNIOR: Persona = {
  id: '5e700000-0000-4000-aa00-000000000003',
  email: 'srr-junior@test.spec',
  role: 'JUNIOR',
}
const STACK = ['React', 'Go', 'AWS']
const TARGET: Persona = {
  id: '5e700000-0000-4000-aa00-000000000005',
  email: 'srr-target@test.spec',
  role: 'SENIOR',
  techStack: STACK,
}
const SELF: Persona = {
  id: '5e700000-0000-4000-aa00-000000000006',
  email: 'srr-self@test.spec',
  role: 'SENIOR',
  techStack: STACK,
}
// Review fix (CR-M-3 / SR-M-1): the role-change cases, each on its own row.
const DEMOTE_VIA_ROLE: Persona = {
  id: '5e700000-0000-4000-aa00-000000000007',
  email: 'srr-demote-role@test.spec',
  role: 'SENIOR',
  techStack: STACK,
  technicalRoles: ['BACKEND_ENGINEER'],
}
const DEMOTE_VIA_EDIT: Persona = {
  id: '5e700000-0000-4000-aa00-000000000008',
  email: 'srr-demote-edit@test.spec',
  role: 'SENIOR',
  techStack: STACK,
  technicalRoles: ['QA_ENGINEER'],
}
const PROMOTE: Persona = {
  id: '5e700000-0000-4000-aa00-000000000009',
  email: 'srr-promote@test.spec',
  role: 'JUNIOR',
  techStack: STACK,
}
const PERSONAS = [ADMIN, HR, JUNIOR, TARGET, SELF, DEMOTE_VIA_ROLE, DEMOTE_VIA_EDIT, PROMOTE]

const WALLET = '0x' + '2'.repeat(40)

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
class SeniorRolesTestModule {}

describe.skipIf(!hasDatabaseUrl())(
  'Senior technical roles — real backend (real DB, real guards)',
  () => {
    let app: NestFastifyApplication
    let jwt: JwtService
    let db: DatabaseService['db']
    let usersService: UsersService

    const tokenFor = (p: Persona) => jwt.sign({ id: p.id, email: p.email, role: p.role })
    const call = async (
      method: 'POST' | 'PATCH',
      url: string,
      as: Persona | null,
      payload: object,
    ) => {
      const res = await app.inject({
        method,
        url,
        ...(as && { cookies: { jwt: tokenFor(as) } }),
        payload,
      })
      const body = res.body ? (res.json() as { code?: string }) : {}
      return { status: res.statusCode, code: body.code }
    }
    const rowByEmail = (email: string) =>
      db.query.users.findFirst({ where: eq(users.email, email) })
    const rolesOf = async (id: string) =>
      (await db.query.users.findFirst({ where: eq(users.id, id) }))?.technicalRoles

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
      await db.delete(jobDirtyWork).where(inArray(jobDirtyWork.entityId, ids))
      await db.delete(seniorResumes).where(inArray(seniorResumes.userId, ids))
      await db.delete(userAuditLog).where(inArray(userAuditLog.targetId, ids))
      await db.delete(userAuditLog).where(inArray(userAuditLog.actorId, ids))
      await db.delete(userEmails).where(inArray(userEmails.userId, ids))
      await db.delete(users).where(inArray(users.id, ids))
    }

    beforeAll(async () => {
      await assertRealDbSchema([{ table: 'users', column: 'technical_roles' }])
      const moduleRef = await Test.createTestingModule({ imports: [SeniorRolesTestModule] })
        .overrideGuard(RolesGuard)
        .useValue(new RolesGuard(new Reflector()))
        .overrideInterceptor(AuditInterceptor)
        .useValue({ intercept: (_c: unknown, next: { handle: () => unknown }) => next.handle() })
        .compile()
      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'senior-roles-cookie-secret' })
      app.setGlobalPrefix('api')
      // Registered globally in main.ts; without it a ZodError surfaces as 500.
      app.useGlobalFilters(new ZodExceptionFilter())
      await app.init()
      await app.getHttpAdapter().getInstance().ready()
      jwt = moduleRef.get(JwtService)
      usersService = moduleRef.get(UsersService)
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
          displayName: `SRR ${p.role}`,
          role: p.role,
          techStack: p.techStack ?? null,
          technicalRoles: p.technicalRoles ?? [],
          googleId: `srr-google-${p.id}`,
        })),
      )
    })

    afterAll(async () => {
      if (db) await wipe()
      if (app) await app.close()
    })

    describe('PATCH /users/:id — admin edit', () => {
      it('ADMIN sets a SENIOR’s roles; they are stored sorted', async () => {
        expect(
          (
            await call('PATCH', `/api/users/${TARGET.id}`, ADMIN, {
              technicalRoles: ['DATA_ENGINEER', 'BACKEND_ENGINEER'],
            })
          ).status,
        ).toBe(200)
        expect(await rolesOf(TARGET.id)).toEqual(['BACKEND_ENGINEER', 'DATA_ENGINEER'])
      })

      it.each([HR, JUNIOR, SELF])('$role gets 403 and nothing is written', async (p) => {
        expect(
          await call('PATCH', `/api/users/${TARGET.id}`, p, { technicalRoles: ['QA_ENGINEER'] }),
        ).toMatchObject({ status: 403 })
        expect(await rolesOf(TARGET.id)).toEqual(['BACKEND_ENGINEER', 'DATA_ENGINEER'])
      })

      it('roles on a JUNIOR -> 400 TECHNICAL_ROLES_SENIOR_ONLY, nothing written', async () => {
        expect(
          await call('PATCH', `/api/users/${JUNIOR.id}`, ADMIN, {
            technicalRoles: ['BACKEND_ENGINEER'],
          }),
        ).toEqual({ status: 400, code: 'TECHNICAL_ROLES_SENIOR_ONLY' })
        expect(await rolesOf(JUNIOR.id)).toEqual([])
      })

      it('the vacancy-only SOFTWARE_ENGINEER and an empty list are rejected by validation', async () => {
        const patch = async (technicalRoles: string[]) => {
          const res = await app.inject({
            method: 'PATCH',
            url: `/api/users/${TARGET.id}`,
            cookies: { jwt: tokenFor(ADMIN) },
            payload: { technicalRoles },
          })
          const body = res.json() as { errors: { path: string; code?: string }[] }
          return { status: res.statusCode, first: body.errors[0] }
        }
        const vacancyOnly = await patch(['SOFTWARE_ENGINEER'])
        expect(vacancyOnly.status).toBe(400)
        expect(vacancyOnly.first?.path).toMatch(/^technicalRoles/)
        expect(await patch([])).toEqual({
          status: 400,
          first: expect.objectContaining({ path: 'technicalRoles', code: 'SENIOR_MIN_ROLES' }),
        })
        expect(await rolesOf(TARGET.id)).toEqual(['BACKEND_ENGINEER', 'DATA_ENGINEER'])
      })
    })

    describe('POST /users — create', () => {
      it('HR creates a SENIOR with roles -> 201 and the roles are stored', async () => {
        const email = `${EMAIL_PREFIX}hr-senior${EMAIL_DOMAIN}`
        const res = await call('POST', '/api/users', HR, {
          email,
          displayName: 'SRR HR Senior',
          role: 'SENIOR',
          hrIds: [HR.id],
          techStack: STACK,
          technicalRoles: ['FRONTEND_ENGINEER'],
        })
        expect(res.status).toBe(201)
        expect((await rowByEmail(email))?.technicalRoles).toEqual(['FRONTEND_ENGINEER'])
      })

      it('ADMIN creating a JUNIOR with roles -> 400 TECHNICAL_ROLES_SENIOR_ONLY, no user row', async () => {
        const email = `${EMAIL_PREFIX}admin-junior${EMAIL_DOMAIN}`
        const res = await call('POST', '/api/users', ADMIN, {
          email,
          displayName: 'SRR Junior',
          role: 'JUNIOR',
          legalFullName: 'Тестовий Джуніор Іванович',
          paymentMethod: 'USDT_ERC20',
          walletUsdtErc20: WALLET,
          technicalRoles: ['BACKEND_ENGINEER'],
        })
        expect(res).toEqual({ status: 400, code: 'TECHNICAL_ROLES_SENIOR_ONLY' })
        expect(await rowByEmail(email)).toBeUndefined()
      })
    })

    describe('PATCH /users/me — self-edit', () => {
      it('a SENIOR sets their own roles; another senior is untouched', async () => {
        const before = await rolesOf(TARGET.id)
        expect(
          (await call('PATCH', '/api/users/me', SELF, { technicalRoles: ['ML_ENGINEER'] })).status,
        ).toBe(200)
        expect(await rolesOf(SELF.id)).toEqual(['ML_ENGINEER'])
        expect(await rolesOf(TARGET.id)).toEqual(before)
      })

      it('a stack-only edit still passes and leaves the roles as they are', async () => {
        expect(
          (await call('PATCH', '/api/users/me', SELF, { techStack: [...STACK, 'Docker'] })).status,
        ).toBe(200)
        expect(await rolesOf(SELF.id)).toEqual(['ML_ENGINEER'])
      })

      it('a JUNIOR setting roles -> 400 TECHNICAL_ROLES_SENIOR_ONLY, nothing written', async () => {
        expect(
          await call('PATCH', '/api/users/me', JUNIOR, { technicalRoles: ['BACKEND_ENGINEER'] }),
        ).toEqual({ status: 400, code: 'TECHNICAL_ROLES_SENIOR_ONLY' })
        expect(await rolesOf(JUNIOR.id)).toEqual([])
      })

      it('a JUNIOR name edit still passes (the role re-check is for a roles write only)', async () => {
        expect(
          (await call('PATCH', '/api/users/me', JUNIOR, { displayName: 'SRR JUNIOR 2' })).status,
        ).toBe(200)
      })

      // Review SR2-L-1: an admin demotion landing between the role read and the write.
      it('a SENIOR demoted after the role read -> 400 TECHNICAL_ROLES_SENIOR_ONLY, roles stay []', async () => {
        const racer = {
          id: '5e700000-0000-4000-aa00-0000000000a1',
          email: 'srr-racer@test.spec',
        }
        await db.insert(users).values({
          ...racer,
          displayName: 'SRR racer',
          role: 'SENIOR',
          techStack: STACK,
          technicalRoles: [],
          googleId: `srr-google-${racer.id}`,
        })
        const read = usersService.findById.bind(usersService)
        const spy = vi.spyOn(usersService, 'findById').mockImplementationOnce(async (id) => {
          const row = await read(id)
          await db.update(users).set({ role: 'JUNIOR' }).where(eq(users.id, racer.id))
          return row
        })
        try {
          await expect(
            usersService.updateProfile(racer.id, { technicalRoles: ['ML_ENGINEER'] }),
          ).rejects.toMatchObject({
            response: expect.objectContaining({ code: 'TECHNICAL_ROLES_SENIOR_ONLY' }),
          })
          expect(spy).toHaveBeenCalledTimes(1)
        } finally {
          spy.mockRestore()
        }
        expect(await rolesOf(racer.id)).toEqual([])
      })

      /** A fresh SENIOR self-editing row, optionally with a VERIFIED resume. */
      async function selfEditor(suffix: string, verified: boolean): Promise<string> {
        const id = `5e700000-0000-4000-aa00-0000000000${suffix}`
        await db.insert(users).values({
          id,
          email: `srr-self-${suffix}@test.spec`,
          displayName: 'SRR self editor',
          role: 'SENIOR',
          techStack: STACK,
          technicalRoles: ['BACKEND_ENGINEER'],
          googleId: `srr-google-${id}`,
        })
        if (verified)
          await db.insert(seniorResumes).values({ userId: id, verificationStatus: 'VERIFIED' })
        return id
      }
      const dirtyReasons = async (id: string) =>
        (
          await db
            .select({ reason: jobDirtyWork.reason })
            .from(jobDirtyWork)
            .where(eq(jobDirtyWork.entityId, id))
        ).map((r) => r.reason)
      /** `findById` reads the row, then `race` runs before the write (an admin edit landing). */
      const raceAfterRead = (race: (id: string) => Promise<unknown>) => {
        const read = usersService.findById.bind(usersService)
        return vi.spyOn(usersService, 'findById').mockImplementationOnce(async (id) => {
          const row = await read(id)
          await race(id)
          return row
        })
      }

      // Senior roles PR 4 Task 4.3: a roles-only self-edit is no longer the plain UPDATE.
      it('a roles-only self-edit commits with one senior.roles dirty row; a resubmit adds none', async () => {
        const id = await selfEditor('b1', false)
        await usersService.updateProfile(id, { technicalRoles: ['DATA_ENGINEER'] })
        expect(await dirtyReasons(id)).toEqual(['senior.roles'])
        await usersService.updateProfile(id, { technicalRoles: ['DATA_ENGINEER'] })
        expect(await dirtyReasons(id)).toEqual(['senior.roles'])
      })

      // Correction 3: roles + name with a VERIFIED resume, demoted between the read and the write.
      it('roles + name, VERIFIED resume, demoted after the read -> 400, no re-check flag, nothing written', async () => {
        const id = await selfEditor('b2', true)
        const spy = raceAfterRead((uid) =>
          db.update(users).set({ role: 'JUNIOR' }).where(eq(users.id, uid)),
        )
        try {
          await expect(
            usersService.updateProfile(id, {
              displayName: 'SRR renamed',
              technicalRoles: ['ML_ENGINEER'],
            }),
          ).rejects.toMatchObject({
            response: expect.objectContaining({
              code: 'TECHNICAL_ROLES_SENIOR_ONLY',
              statusCode: 400,
            }),
          })
          expect(spy).toHaveBeenCalledTimes(1)
        } finally {
          spy.mockRestore()
        }
        const [resume] = await db
          .select({ recheckNeededAt: seniorResumes.recheckNeededAt })
          .from(seniorResumes)
          .where(eq(seniorResumes.userId, id))
        expect(resume?.recheckNeededAt).toBeNull()
        const row = await db.query.users.findFirst({ where: eq(users.id, id) })
        expect(row?.displayName).toBe('SRR self editor')
        expect(row?.technicalRoles).toEqual(['BACKEND_ENGINEER'])
        expect(await dirtyReasons(id)).toEqual([])
      })

      // Correction 3: the guarded UPDATE missed because the row is gone, not because of a demotion.
      it('a roles self-edit on a row deleted after the read -> 404 USER_NOT_FOUND', async () => {
        const id = await selfEditor('b3', false)
        const spy = raceAfterRead((uid) => db.delete(users).where(eq(users.id, uid)))
        try {
          await expect(
            usersService.updateProfile(id, { technicalRoles: ['ML_ENGINEER'] }),
          ).rejects.toMatchObject({
            response: expect.objectContaining({ code: 'USER_NOT_FOUND', statusCode: 404 }),
          })
        } finally {
          spy.mockRestore()
        }
        expect(await dirtyReasons(id)).toEqual([])
      })

      it('unauthenticated -> 401', async () => {
        expect(
          await call('PATCH', '/api/users/me', null, { technicalRoles: ['BACKEND_ENGINEER'] }),
        ).toMatchObject({ status: 401 })
      })
    })

    // Review fix (CR-M-3 / SR-M-1): only a SENIOR holds roles, so a role change away from SENIOR
    // clears them in the same write — otherwise nobody could clear them and a re-promotion would
    // silently restore them.
    describe('role changes', () => {
      it('PATCH /users/:id/role away from SENIOR clears the stored roles', async () => {
        expect(await rolesOf(DEMOTE_VIA_ROLE.id)).toEqual(['BACKEND_ENGINEER'])
        expect(
          (await call('PATCH', `/api/users/${DEMOTE_VIA_ROLE.id}/role`, ADMIN, { role: 'HR' }))
            .status,
        ).toBe(200)
        expect(await rolesOf(DEMOTE_VIA_ROLE.id)).toEqual([])
      })

      it('PATCH /users/:id with a role change away from SENIOR clears the stored roles', async () => {
        expect(await rolesOf(DEMOTE_VIA_EDIT.id)).toEqual(['QA_ENGINEER'])
        expect(
          (await call('PATCH', `/api/users/${DEMOTE_VIA_EDIT.id}`, ADMIN, { role: 'HR' })).status,
        ).toBe(200)
        expect(await rolesOf(DEMOTE_VIA_EDIT.id)).toEqual([])
      })

      it('PATCH /users/:id promoting to SENIOR with roles in the same body stores them', async () => {
        expect(
          (
            await call('PATCH', `/api/users/${PROMOTE.id}`, ADMIN, {
              role: 'SENIOR',
              technicalRoles: ['DEVOPS_ENGINEER', 'CTO'],
            })
          ).status,
        ).toBe(200)
        // Catalog order (sortRoles), not alphabetical.
        expect(await rolesOf(PROMOTE.id)).toEqual(['DEVOPS_ENGINEER', 'CTO'])
      })
    })
  },
)
