/**
 * SR-M-17 (security-review PR #623, closing round) — the REAL `@Roles('ADMIN')`
 * wiring on `PATCH /users/:id/personal-email` and
 * `POST /users/:id/personal-email/resend-invite` was covered by ZERO of the
 * 3512 tests in this repo. Both routes carry `@UseGuards(RolesGuard)` at the
 * CLASS level (`UsersController`) — `RolesGuard.canActivate` starts with
 * `if (!required || required.length === 0) return true`, so a REMOVED
 * `@Roles('ADMIN')` annotation does not close the route, it OPENS it to
 * every authenticated caller while `@UseGuards(RolesGuard)` still sits right
 * there looking like protection. This is an account-takeover primitive
 * (change someone's login address, then re-send the invite to yourself) —
 * the same class of bug this repo has shipped three times before (#159,
 * #160, #161 — see the `security-review` skill).
 *
 * Every prior test touching these two handlers (`users.controller.spec.ts`,
 * `user-email-invites.integration.spec.ts`) calls `UsersService` /
 * `UsersController` methods DIRECTLY — none of them go through Fastify, so
 * none of them exercise `@UseGuards(RolesGuard)` at all
 * (`feedback_mocked_e2e_guards` — recurred 3× before this file).
 *
 * This spec stands up the REAL `UsersController` behind the REAL
 * `JwtAuthGuard` + `RolesGuard` chain (same pattern as
 * `finance-controller-guards.rbac.integration.spec.ts`) and asserts the HTTP
 * status code — removing `@Roles('ADMIN')` from either handler turns every
 * 403 case in this file into a 404 (`RolesGuard` lets the caller through, the
 * stubbed service throws `NotFoundException` next) — proven by mutation, see
 * this PR's own commit message.
 *
 * SCOPE (mirrors the finance-controller-guards spec's own disclaimer): the
 * rig below registers ONLY `JwtAuthGuard` (test-constructed, DB-backed via a
 * stub `UsersService.findById`) + `RolesGuard` — it does NOT stand up the
 * full production guard chain `JwtAuthGuard → OnboardingGuard →
 * ThrottlerGuard` (`app.module.ts`). This spec makes no claim about
 * onboarding-gating or throttling on these two routes; it exists ONLY to pin
 * that `@Roles('ADMIN')` is wired on the HTTP route.
 *
 * `UsersService.resendPersonalEmailInvite` / `.changePersonalEmail` are
 * stubbed to throw `NotFoundException` unconditionally — the point of this
 * file is the GUARD, not the business logic (that is
 * `user-email-invites.integration.spec.ts`'s job). A caller that gets PAST
 * the guard reaches the stub and gets exactly 404 with a message that can
 * ONLY have come from THIS stub — not Fastify's generic unmatched-route 404,
 * and not some other, unrelated 404 source (same reasoning as the
 * edit-preview guard spec in finance-controller-guards.rbac.integration.spec.ts).
 *
 * No real Postgres required — `DatabaseService` is never referenced.
 */

import { NotFoundException } from '@nestjs/common'
import { Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import type { ConfigService } from '@nestjs/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import type { ResendMailerService, SendEmailInput } from '../contact/resend-mailer.service'
import type { Env } from '../config/env'
import type { TelemetryErrorsService } from '../telemetry/telemetry-errors.service'
import { AuditInterceptor } from '../common/interceptors/audit.interceptor'
import { AuditLogService } from './audit-log.service'
import { PersonalEmailInviteMailerService } from './personal-email-invite-mailer.service'
import { UsersAccessService } from './users-access.service'
import { UsersController } from './users.controller'
import { UsersService } from './users.service'

const JWT_SECRET = 'personal-email-controller-guards-rbac-secret-32c'

type Role = 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP'

interface Persona {
  id: string
  email: string
  role: Role
}

const ADMIN: Persona = {
  id: 'fec90000-0000-4000-aa00-000000000001',
  email: 'pecg-admin@test.spec',
  role: 'ADMIN',
}
const SENIOR: Persona = {
  id: 'fec90000-0000-4000-aa00-000000000002',
  email: 'pecg-senior@test.spec',
  role: 'SENIOR',
}
const JUNIOR: Persona = {
  id: 'fec90000-0000-4000-aa00-000000000003',
  email: 'pecg-junior@test.spec',
  role: 'JUNIOR',
}
const HR: Persona = {
  id: 'fec90000-0000-4000-aa00-000000000004',
  email: 'pecg-hr@test.spec',
  role: 'HR',
}
const ACCOUNTANT: Persona = {
  id: 'fec90000-0000-4000-aa00-000000000005',
  email: 'pecg-accountant@test.spec',
  role: 'ACCOUNTANT',
}
const DROP: Persona = {
  id: 'fec90000-0000-4000-aa00-000000000006',
  email: 'pecg-drop@test.spec',
  role: 'DROP',
}

const ALL: Persona[] = [ADMIN, SENIOR, JUNIOR, HR, ACCOUNTANT, DROP]
// SR-M-17's explicit list — every role that must NOT reach either handler.
const NON_ADMIN: Persona[] = [SENIOR, JUNIOR, HR, ACCOUNTANT, DROP]

const ROLE_ROWS = new Map<string, { role: Role; archivedAt: Date | null }>(
  ALL.map((p) => [p.id, { role: p.role, archivedAt: null }]),
)

// `JwtAuthGuard` re-hydrates role/archived status from `UsersService.findById`
// (AC2, jwt.guard.ts) — this is the ONLY method of `UsersService` it needs.
// `UsersController.resendPersonalEmailInvite` / `.changePersonalEmail` are
// stubbed to throw unconditionally: this file exists to pin the GUARD, the
// business logic itself is `user-email-invites.integration.spec.ts`'s job.
const STUB_NOT_FOUND_MESSAGE = 'stub: personal-email-controller-guards rig — guard test only'
//
// i18n emails PR2: the two service methods can ALSO be switched to return an invitee result (the
// `inviteeResult` slot below), so the sender-locale tests can drive the REAL controller -> REAL
// mailer path. Default (null) keeps the original guard-only behaviour: reject with the stub 404.
interface InviteeResult {
  rawToken: string
  email: string
  displayName: string
  locale: 'uk' | 'en'
}
let inviteeResult: InviteeResult | null = null
const usersServiceStub = {
  findById: (id: string) => Promise.resolve(ROLE_ROWS.get(id)),
  resendPersonalEmailInvite: () =>
    inviteeResult
      ? Promise.resolve(inviteeResult)
      : Promise.reject(new NotFoundException(STUB_NOT_FOUND_MESSAGE)),
  changePersonalEmail: () =>
    inviteeResult
      ? Promise.resolve(inviteeResult)
      : Promise.reject(new NotFoundException(STUB_NOT_FOUND_MESSAGE)),
} as unknown as UsersService

// The REAL mailer, with only the outbound HTTP hop to Resend captured. Guard-only cases never
// reach it (the stubbed service rejects BEFORE the controller calls it); the sender-locale cases
// at the bottom do, and assert on what would have left the process.
const sentMails: SendEmailInput[] = []
const mailerEnv: Record<string, string> = {
  FRONTEND_URL: 'https://app.cheekycheese.tech',
  CONTACT_PUBLIC_EMAIL: 'hr@cheekycheese.tech',
}
const inviteMailerStub = new PersonalEmailInviteMailerService(
  {
    isConfigured: true,
    send: (input: SendEmailInput) => {
      sentMails.push(input)
      return Promise.resolve()
    },
  } as unknown as ResendMailerService,
  { recordError: () => Promise.resolve() } as unknown as TelemetryErrorsService,
  { get: (k: string) => mailerEnv[k] } as unknown as ConfigService<Env, true>,
)

// `@UseInterceptors(AuditInterceptor)` sits at the CLASS level on
// `UsersController`. Neither target handler carries `@AuditLog` (see
// UsersController's own doc on both routes for why), so a pass-through stub
// is behaviorally identical to the real interceptor here — but a plain
// `providers: [{ provide: AuditInterceptor, useValue: ... }]` entry is NOT
// what Nest's controller-level enhancer resolution reads for a class
// referenced directly in `@UseInterceptors()` (confirmed by running this
// file: the REAL class still got constructed, with `Reflector` unresolved).
// `overrideInterceptor` — the same override-builder API `overrideGuard`
// below uses for `RolesGuard`, also referenced by class at the controller
// level — is the one that actually reaches it.
const auditInterceptorStub = {
  intercept: (_ctx: unknown, next: { handle: () => unknown }) => next.handle(),
}

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
  controllers: [UsersController],
  providers: [
    Reflector,
    { provide: UsersService, useValue: usersServiceStub },
    { provide: AuditLogService, useValue: {} },
    { provide: UsersAccessService, useValue: {} },
    { provide: PersonalEmailInviteMailerService, useValue: inviteMailerStub },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) =>
        new JwtAuthGuard(jwtSvc, reflector, usersServiceStub),
      inject: [JwtService, Reflector],
    },
  ],
})
class PersonalEmailGuardsTestModule {}

describe("UsersController personal-email routes — real @Roles('ADMIN') RBAC integration", () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PersonalEmailGuardsTestModule],
    })
      // Same reason as finance-controller-guards.rbac.integration.spec.ts:
      // `RolesGuard` is referenced by class at the CONTROLLER level
      // (`@UseGuards(RolesGuard)`), not registered as an ordinary provider —
      // `overrideGuard` is how the testing module supplies a real instance
      // for it.
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .overrideInterceptor(AuditInterceptor)
      .useValue(auditInterceptorStub)
      .compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'personal-email-controller-guards-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)

    // `UsersController`'s constructor injects its 4 collaborators by
    // IMPLICIT TypeScript type (no `@Inject()` tokens — unlike e.g.
    // `TransactionsController`, which explicitly does
    // `@Inject(TransactionsService)`). That relies on `design:paramtypes`
    // metadata, which Vite/esbuild's TS transform does not emit (a known
    // esbuild limitation — `emitDecoratorMetadata` is a full-type-checker
    // feature esbuild deliberately skips for speed). Under this Vitest
    // config, Nest therefore constructs `UsersController` with all 4 fields
    // `undefined`, regardless of what is registered as providers above
    // (confirmed empirically writing this file — both handlers threw
    // `TypeError: Cannot read properties of undefined` on their first field
    // access). Overwriting the fields directly on the DI-built instance
    // AFTER construction — same "plain assignment onto a `readonly` TS
    // field, which is not actually readonly at the JS runtime level" trick
    // `finance-controller-guards.rbac.integration.spec.ts`'s
    // `TestDatabaseModule` uses for `DatabaseService` — is what actually
    // wires the stubs in.
    Object.assign(app.get(UsersController), {
      usersService: usersServiceStub,
      auditLogService: {},
      accessService: {},
      inviteMailer: inviteMailerStub,
    })
  })

  afterAll(async () => {
    await app.close()
  })

  const tokenFor = (p: Persona) => jwt.sign({ id: p.id, email: p.email, role: p.role })

  async function post(user: Persona, url: string): Promise<number> {
    const res = await app.inject({ method: 'POST', url, cookies: { jwt: tokenFor(user) } })
    return res.statusCode
  }
  async function patch(user: Persona, url: string, payload: unknown): Promise<number> {
    const res = await app.inject({
      method: 'PATCH',
      url,
      cookies: { jwt: tokenFor(user) },
      payload: payload as object,
    })
    return res.statusCode
  }

  const TARGET_ID = 'fec90000-0000-4000-ac00-000000000099'
  const resendUrl = `/api/users/${TARGET_ID}/personal-email/resend-invite`
  const changeUrl = `/api/users/${TARGET_ID}/personal-email`
  const changePayload = { personalEmail: 'new-address@test.spec' }

  describe("POST /users/:id/personal-email/resend-invite — @Roles('ADMIN') guard", () => {
    for (const persona of NON_ADMIN) {
      it(`${persona.role} → 403 (ADMIN only)`, async () => {
        expect(await post(persona, resendUrl)).toBe(403)
      })
    }

    it('ADMIN passes the guard — reaches the stubbed service (404, not 403)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: resendUrl,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(res.statusCode).toBe(404)
      // Positive assert (mirrors the finance-controller-guards edit-preview
      // spec's own reasoning): this 404 can ONLY have come from OUR stub —
      // proof the request reached the controller/service, not Fastify's
      // generic unmatched-route 404 or some unrelated 404 source.
      expect(JSON.parse(res.payload).message).toBe(STUB_NOT_FOUND_MESSAGE)
    })
  })

  describe("PATCH /users/:id/personal-email — @Roles('ADMIN') guard", () => {
    for (const persona of NON_ADMIN) {
      it(`${persona.role} → 403 (ADMIN only)`, async () => {
        expect(await patch(persona, changeUrl, changePayload)).toBe(403)
      })
    }

    it('ADMIN passes the guard — reaches the stubbed service (404, not 403)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: changeUrl,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: changePayload,
      })
      expect(res.statusCode).toBe(404)
      expect(JSON.parse(res.payload).message).toBe(STUB_NOT_FOUND_MESSAGE)
    })
  })

  // i18n emails PR2 — the invite is written in the INVITEE's language. The only request present
  // at send time is the ADMIN's; its `pref_locale` cookie and `Accept-Language` must never reach
  // the mail. Driven over real HTTP through the real guard chain, real controller, real mailer.
  describe('invite language — the sender (admin) request locale never leaks into the mail', () => {
    const EN_HEADERS = { 'accept-language': 'en-US,en;q=0.9' }

    afterAll(() => {
      inviteeResult = null
    })

    it('admin with pref_locale=en + Accept-Language: en resends to a UK invitee -> the mail is Ukrainian', async () => {
      inviteeResult = {
        rawToken: 'a'.repeat(64),
        email: 'uk.invitee@test.spec',
        displayName: 'Іван Петров',
        locale: 'uk',
      }
      sentMails.length = 0
      const res = await app.inject({
        method: 'POST',
        url: resendUrl,
        headers: EN_HEADERS,
        cookies: { jwt: tokenFor(ADMIN), pref_locale: 'en' },
      })
      expect(res.statusCode).toBe(201)
      expect(JSON.parse(res.payload)).toEqual({ ok: true, delivered: true })
      expect(sentMails).toHaveLength(1)
      expect(sentMails[0]!.subject).toBe('Доступ до CRM CheekyCheeseIT')
      expect(sentMails[0]!.html).toContain('<html lang="uk">')
    })

    it('admin with a UK cookie + Accept-Language: uk resends to an EN invitee -> the mail is English', async () => {
      inviteeResult = {
        rawToken: 'b'.repeat(64),
        email: 'en.invitee@test.spec',
        displayName: 'John Smith',
        locale: 'en',
      }
      sentMails.length = 0
      const res = await app.inject({
        method: 'POST',
        url: resendUrl,
        headers: { 'accept-language': 'uk-UA,uk;q=0.9' },
        cookies: { jwt: tokenFor(ADMIN), pref_locale: 'uk' },
      })
      expect(res.statusCode).toBe(201)
      expect(sentMails).toHaveLength(1)
      expect(sentMails[0]!.subject).toBe('Access to CheekyCheeseIT CRM')
      expect(sentMails[0]!.html).toContain('<html lang="en">')
    })

    it('PATCH personal-email: an English-speaking admin changing a UK invitee address -> Ukrainian mail', async () => {
      inviteeResult = {
        rawToken: 'c'.repeat(64),
        email: 'new.uk.invitee@test.spec',
        displayName: 'Олена Коваль',
        locale: 'uk',
      }
      sentMails.length = 0
      const res = await app.inject({
        method: 'PATCH',
        url: changeUrl,
        headers: EN_HEADERS,
        cookies: { jwt: tokenFor(ADMIN), pref_locale: 'en' },
        payload: changePayload,
      })
      expect(res.statusCode).toBe(200)
      expect(sentMails).toHaveLength(1)
      expect(sentMails[0]!.subject).toBe('Доступ до CRM CheekyCheeseIT')
      expect(sentMails[0]!.html).toContain('<html lang="uk">')
    })

    it('non-ADMIN stays 403 on both endpoints while the service WOULD succeed (the surface is not loosened; nothing is sent)', async () => {
      inviteeResult = {
        rawToken: 'd'.repeat(64),
        email: 'x.invitee@test.spec',
        displayName: 'X',
        locale: 'uk',
      }
      sentMails.length = 0
      for (const persona of NON_ADMIN) {
        expect(await post(persona, resendUrl)).toBe(403)
        expect(await patch(persona, changeUrl, changePayload)).toBe(403)
      }
      expect(sentMails).toHaveLength(0)
    })
  })
})
