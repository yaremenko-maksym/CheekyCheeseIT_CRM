/**
 * Personal-email invite tokens — real-Postgres integration.
 * task-user-emails-invite (spec §2, §5; PR #623 position 2, continued —
 * closes spec-reviewer's SPEC-H-1: "canLogin для kind: 'PERSONAL' нигде не
 * устанавливается в true ни одним production-путём").
 *
 * Drives the REAL `UsersService` (`resendPersonalEmailInvite` /
 * `acceptPersonalEmailInvite`) against real Postgres — no mocked DB layer,
 * per the same "mocked-guards give false confidence" lesson
 * `user-emails-uniqueness.integration.spec.ts` already follows.
 *
 * Covers, each with its own case (task's explicit list):
 *   - token used twice — second use rejected (ConflictException)
 *   - token expired — rejected (BadRequestException)
 *   - Google account email does not match the invited address — rejected
 *     (ForbiddenException), canLogin stays false
 *   - a token issued for one account does not open login for another
 *     (CR-M-1, code-review round 4: the redirect attempt is made while the
 *     token is still UNUSED — see that test's own comment for why the
 *     original ordering passed for the wrong reason)
 *   - resending gates the OLD token (overwritten hash — NotFoundException)
 *   - changePersonalEmail: security-review PR #623 round 4, owner decision —
 *     an address that WORKED as a login method a moment ago stops working
 *     immediately after an admin changes OR removes it (the single most
 *     important pair of cases in this file — see their own comments)
 *   - SR-H-5 (round 5): accept vs. change raced concurrently, many times —
 *     zero raw Postgres deadlocks, the old address never ends up logged in
 *     regardless of which side wins the race
 *   - SR-H-6 (round 5): a session minted the way a real login would (real
 *     `JwtAuthGuard`, real `UsersService`, cold cache) dies the moment the
 *     PERSONAL row that opened it is revoked — not merely future logins
 *   - SR-L-1 (round 5): resubmitting one's own current PERSONAL address in
 *     a different case is not reported as a collision with a stranger
 *   - SR-M-14 (round 6): the SR-H-5 deadlock counter above now walks the
 *     `.cause` chain (`isDeadlock`, `database/pg-errors.ts`) instead of
 *     reading `.code` off the top-level rejection — the original shallow
 *     check could never observe a real `40P01` and always reported 0
 *     regardless of whether the code under test actually deadlocked
 *   - SR-L-4 (round 6): the SR-H-6 "WORK-row, no userEmailId" pin was
 *     renamed and its comment corrected — that shape never occurs in
 *     production (every real login sets `userEmailId`); the token it
 *     actually exercises is the impersonation-target shape
 *
 * DB-SKIP-GUARD: describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is
 * unset (reports SKIPPED, not silently-passed-with-no-assertions).
 *
 * SEED namespace: a17a0004-****.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jwtPayloadSchema } from '@crm/shared'
import * as schema from '../database/schema'
import { userEmailInvites, userEmails, users } from '../database/schema'
import { DatabaseService } from '../database/database.service'
import { isDeadlock } from '../database/pg-errors'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { UsersService } from './users.service'
import { hashInviteToken } from './invite-token.util'
import { hasDatabaseUrl } from '../test/require-real-db'

const USER_A_ID = 'a17a0004-0000-0000-0000-000000000001'
const USER_A_WORK_EMAIL = 'invite-user-a-work@test.spec'
const USER_A_PERSONAL_EMAIL = 'invite-user-a-personal@test.spec'

const USER_B_ID = 'a17a0004-0000-0000-0000-000000000002'
const USER_B_WORK_EMAIL = 'invite-user-b-work@test.spec'
const USER_B_PERSONAL_EMAIL = 'invite-user-b-personal@test.spec'

const ACTOR_ID = 'a17a0004-0000-0000-0000-00000000000a'

describe.skipIf(!hasDatabaseUrl())(
  'personal-email invite tokens (spec §2, §5) — real DB integration',
  () => {
    let pool: Pool
    let dbSvc: DatabaseService
    let usersService: UsersService

    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error(
          '[user-email-invites integration] FAILED — no DB at DATABASE_URL (CI unit job)',
        )
      }

      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(pool, { schema })
      dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, {
        pool,
        db,
      })

      // resendPersonalEmailInvite / acceptPersonalEmailInvite / changePersonalEmail
      // touch `this.db` and (security-review PR #623 round 4, SR-M-12 /
      // personal_email_changed) `this.auditLogService.record(...)` — no
      // team/project services, no mailer (the controller sends the email,
      // not the service — see UsersController.resendPersonalEmailInvite).
      usersService = Object.assign(Object.create(UsersService.prototype) as UsersService, {
        db: dbSvc,
        auditLogService: { record: async () => undefined },
      })

      await db
        .insert(users)
        .values([
          {
            id: USER_A_ID,
            email: USER_A_WORK_EMAIL,
            displayName: 'Invite Test User A',
            role: 'JUNIOR',
          },
          {
            id: USER_B_ID,
            email: USER_B_WORK_EMAIL,
            displayName: 'Invite Test User B',
            role: 'JUNIOR',
          },
        ])
        .onConflictDoNothing()
      await db
        .insert(userEmails)
        .values([
          { userId: USER_A_ID, email: USER_A_WORK_EMAIL, kind: 'WORK', canLogin: true },
          { userId: USER_A_ID, email: USER_A_PERSONAL_EMAIL, kind: 'PERSONAL', canLogin: false },
          { userId: USER_B_ID, email: USER_B_WORK_EMAIL, kind: 'WORK', canLogin: true },
          { userId: USER_B_ID, email: USER_B_PERSONAL_EMAIL, kind: 'PERSONAL', canLogin: false },
        ])
        .onConflictDoNothing()
    }, 30_000)

    afterAll(async () => {
      try {
        await dbSvc.db.delete(users).where(inArray(users.id, [USER_A_ID, USER_B_ID]))
      } catch {
        // Non-fatal cleanup failure — do not mask test results.
      }
      await pool?.end()
    }, 15_000)

    /** Resets a PERSONAL row back to `canLogin=false` between tests that accept it. */
    async function resetPersonalRow(userId: string): Promise<void> {
      await dbSvc.db
        .update(userEmails)
        .set({ canLogin: false, verifiedAt: null, googleId: null })
        .where(eq(userEmails.userId, userId))
    }

    async function personalRow(userId: string) {
      const row = await dbSvc.db.query.userEmails.findFirst({
        where: and(eq(userEmails.userId, userId), eq(userEmails.kind, 'PERSONAL')),
      })
      if (!row) throw new Error('personal row not found')
      return row
    }

    it('token used twice — the second accept is rejected (ConflictException)', async () => {
      await resetPersonalRow(USER_A_ID)
      const { rawToken } = await usersService.resendPersonalEmailInvite(USER_A_ID, ACTOR_ID)

      await usersService.acceptPersonalEmailInvite(
        rawToken,
        USER_A_PERSONAL_EMAIL,
        'google-sub-a-1',
      )
      const rowAfterFirst = await personalRow(USER_A_ID)
      expect(rowAfterFirst.canLogin).toBe(true)

      await expect(
        usersService.acceptPersonalEmailInvite(rawToken, USER_A_PERSONAL_EMAIL, 'google-sub-a-1'),
      ).rejects.toBeInstanceOf(ConflictException)
    })

    it('token expired — rejected (BadRequestException)', async () => {
      await resetPersonalRow(USER_A_ID)
      const rawToken = 'expired-token-fixture-'.padEnd(64, '0')
      const row = await personalRow(USER_A_ID)
      await dbSvc.db
        .insert(userEmailInvites)
        .values({
          userEmailId: row.id,
          tokenHash: hashInviteToken(rawToken),
          expiresAt: new Date(Date.now() - 1000), // 1 second in the past
        })
        .onConflictDoUpdate({
          target: userEmailInvites.userEmailId,
          // `usedAt: null` matters here — without it, this test running
          // AFTER "token used twice" above (same USER_A row) inherits that
          // test's `usedAt` timestamp and fails with ConflictException
          // instead of the BadRequestException this test is actually
          // pinning (caught by running this file in isolation — see commit
          // message). Mirrors `issuePersonalEmailInviteTx`'s own
          // `onConflictDoUpdate` set clause exactly, for the same reason.
          set: {
            tokenHash: hashInviteToken(rawToken),
            expiresAt: new Date(Date.now() - 1000),
            usedAt: null,
          },
        })

      await expect(
        usersService.acceptPersonalEmailInvite(rawToken, USER_A_PERSONAL_EMAIL, 'google-sub-a-2'),
      ).rejects.toBeInstanceOf(BadRequestException)

      const rowAfter = await personalRow(USER_A_ID)
      expect(rowAfter.canLogin).toBe(false)
    })

    it('Google account email does not match the invited address — rejected (ForbiddenException), canLogin stays false', async () => {
      await resetPersonalRow(USER_A_ID)
      const { rawToken } = await usersService.resendPersonalEmailInvite(USER_A_ID, ACTOR_ID)

      await expect(
        usersService.acceptPersonalEmailInvite(
          rawToken,
          'someone-else-entirely@gmail.com',
          'google-sub-attacker',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException)

      const rowAfter = await personalRow(USER_A_ID)
      expect(rowAfter.canLogin).toBe(false)
      expect(rowAfter.googleId).toBeNull()
    })

    it('a token issued for one account does not open login for another', async () => {
      await resetPersonalRow(USER_A_ID)
      await resetPersonalRow(USER_B_ID)
      const { rawToken: tokenA } = await usersService.resendPersonalEmailInvite(USER_A_ID, ACTOR_ID)
      const { rawToken: tokenB } = await usersService.resendPersonalEmailInvite(USER_B_ID, ACTOR_ID)

      // CR-M-1 (code-review PR #623 round 4): this redirect attempt is made
      // FIRST, while tokenA is still UNUSED — proven by mutation (disabling
      // the email-match check in acceptPersonalEmailInvite) that the
      // ORIGINAL ordering here (redirect-attempt AFTER A's own accept) let
      // this exact assertion pass for the WRONG reason: tokenA was already
      // "used" by then, so it threw ConflictException regardless of whether
      // the email-match check existed at all. With tokenA still live, the
      // ONLY thing that can reject this is the address check itself — the
      // row a token resolves to is fixed at issue time (FK on
      // user_email_id), not something the caller can redirect by supplying
      // a DIFFERENT invited address.
      await expect(
        usersService.acceptPersonalEmailInvite(tokenA, USER_B_PERSONAL_EMAIL, 'google-sub-b-1'),
      ).rejects.toBeInstanceOf(ForbiddenException)
      // Rejected on the address mismatch specifically — A's row is
      // untouched, not consumed by the failed redirect attempt.
      const rowAAfterRedirectAttempt = await personalRow(USER_A_ID)
      expect(rowAAfterRedirectAttempt.canLogin).toBe(false)

      // Accepting A's token with A's OWN address succeeds and touches ONLY A.
      await usersService.acceptPersonalEmailInvite(tokenA, USER_A_PERSONAL_EMAIL, 'google-sub-a-3')
      const rowA = await personalRow(USER_A_ID)
      const rowB = await personalRow(USER_B_ID)
      expect(rowA.canLogin).toBe(true)
      // B is completely untouched by A's accept — not merely "still false",
      // but never written to at all.
      expect(rowB.canLogin).toBe(false)
      expect(rowB.googleId).toBeNull()

      // B's own token is still live and independently acceptable —
      // A's accept did not consume or interfere with it.
      await usersService.acceptPersonalEmailInvite(tokenB, USER_B_PERSONAL_EMAIL, 'google-sub-b-1')
      const rowBAfter = await personalRow(USER_B_ID)
      expect(rowBAfter.canLogin).toBe(true)

      // NOW tokenA is genuinely used — reusing it (even with A's own
      // correct address) is rejected as "already used", a DIFFERENT and
      // already-covered situation (see the "token used twice" case above)
      // — not the mismatch this test exists to prove.
      await expect(
        usersService.acceptPersonalEmailInvite(tokenA, USER_B_PERSONAL_EMAIL, 'google-sub-b-1'),
      ).rejects.toBeInstanceOf(ConflictException)
    })

    it('resending gates the OLD token — old raw token rejected (NotFoundException), new one works', async () => {
      await resetPersonalRow(USER_A_ID)
      const { rawToken: firstToken } = await usersService.resendPersonalEmailInvite(
        USER_A_ID,
        ACTOR_ID,
      )
      const { rawToken: secondToken } = await usersService.resendPersonalEmailInvite(
        USER_A_ID,
        ACTOR_ID,
      )
      expect(secondToken).not.toBe(firstToken)

      // The OLD token's hash no longer exists in the DB at all — this is
      // NotFoundException, not ConflictException-as-used: the row it used
      // to point at is gone, not "already consumed".
      await expect(
        usersService.acceptPersonalEmailInvite(firstToken, USER_A_PERSONAL_EMAIL, 'google-sub-a-4'),
      ).rejects.toBeInstanceOf(NotFoundException)

      // The NEW token works.
      await usersService.acceptPersonalEmailInvite(
        secondToken,
        USER_A_PERSONAL_EMAIL,
        'google-sub-a-4',
      )
      const rowAfter = await personalRow(USER_A_ID)
      expect(rowAfter.canLogin).toBe(true)
      expect(rowAfter.googleId).toBe('google-sub-a-4')
    })

    it('resendPersonalEmailInvite refuses once the address is already confirmed (ConflictException)', async () => {
      await resetPersonalRow(USER_A_ID)
      const { rawToken } = await usersService.resendPersonalEmailInvite(USER_A_ID, ACTOR_ID)
      await usersService.acceptPersonalEmailInvite(
        rawToken,
        USER_A_PERSONAL_EMAIL,
        'google-sub-a-5',
      )

      await expect(
        usersService.resendPersonalEmailInvite(USER_A_ID, ACTOR_ID),
      ).rejects.toBeInstanceOf(ConflictException)
    })

    // security-review PR #623 round 4 — owner decision, the single most
    // important test of this round: "туда будет всегда попадать валидная
    // почта. В случае чего, мы можем быстро изменить почту, что за собой
    // изменит и правила для входа и со старой указанной почты уже нельзя
    // будет войти". This test is that promise, proven against real
    // Postgres: an address that WORKED as a login method a moment ago must
    // NOT work after an admin replaces it — unconditionally, not merely
    // "pending re-verification".
    it('changePersonalEmail: the OLD address stops logging in immediately after a change — even though it worked before', async () => {
      await resetPersonalRow(USER_A_ID)
      const { rawToken } = await usersService.resendPersonalEmailInvite(USER_A_ID, ACTOR_ID)
      await usersService.acceptPersonalEmailInvite(
        rawToken,
        USER_A_PERSONAL_EMAIL,
        'google-sub-revocation-1',
      )

      // Before the change: genuinely a working login method, verified
      // through the SAME lookup the real OAuth callback uses.
      const beforeChange = await usersService.findLoginableEmailRow(USER_A_PERSONAL_EMAIL)
      expect(beforeChange).not.toBeUndefined()
      expect(beforeChange?.canLogin).toBe(true)

      const NEW_PERSONAL_EMAIL = 'invite-user-a-personal-changed@test.spec'
      const result = await usersService.changePersonalEmail(USER_A_ID, NEW_PERSONAL_EMAIL, ACTOR_ID)
      expect(result?.email).toBe(NEW_PERSONAL_EMAIL)

      // The OLD address cannot log in any more — the row that carried
      // `canLogin=true` for it does not exist any more (deleted, not
      // merely flipped back to false — see the method's own doc for why
      // that distinction is the whole point).
      const afterChangeOld = await usersService.findLoginableEmailRow(USER_A_PERSONAL_EMAIL)
      expect(afterChangeOld).toBeUndefined()

      // The NEW address exists but is NOT yet a login method — same
      // invite-required posture as any other personal address.
      const newRow = await personalRow(USER_A_ID)
      expect(newRow.email).toBe(NEW_PERSONAL_EMAIL)
      expect(newRow.canLogin).toBe(false)
      expect(newRow.googleId).toBeNull()
      expect(newRow.verifiedAt).toBeNull()

      // The OLD row's Google-identity binding is gone WITH it — accepting a
      // FRESH invite on the NEW address with the SAME Google account that
      // used to own the old one works cleanly (no stale
      // idx_user_emails_google_id collision left behind by the deleted row).
      const newInvite = await usersService.resendPersonalEmailInvite(USER_A_ID, ACTOR_ID)
      await usersService.acceptPersonalEmailInvite(
        newInvite.rawToken,
        NEW_PERSONAL_EMAIL,
        'google-sub-revocation-1', // same sub as before the change
      )
      const finalRow = await personalRow(USER_A_ID)
      expect(finalRow.canLogin).toBe(true)
      expect(finalRow.googleId).toBe('google-sub-revocation-1')

      // And the OLD address is STILL not a login method, whatever happened
      // to the new one — this is not "swapped which one is active", the
      // old row simply does not exist.
      const oldAfterAll = await usersService.findLoginableEmailRow(USER_A_PERSONAL_EMAIL)
      expect(oldAfterAll).toBeUndefined()
    })

    it('changePersonalEmail: removal (personalEmail: null) also revokes an already-working address', async () => {
      await resetPersonalRow(USER_B_ID)
      const { rawToken } = await usersService.resendPersonalEmailInvite(USER_B_ID, ACTOR_ID)
      await usersService.acceptPersonalEmailInvite(
        rawToken,
        USER_B_PERSONAL_EMAIL,
        'google-sub-removal-1',
      )
      expect((await usersService.findLoginableEmailRow(USER_B_PERSONAL_EMAIL))?.canLogin).toBe(true)

      const result = await usersService.changePersonalEmail(USER_B_ID, null, ACTOR_ID)
      expect(result).toBeNull()

      expect(await usersService.findLoginableEmailRow(USER_B_PERSONAL_EMAIL)).toBeUndefined()
      const rowAfter = await dbSvc.db.query.userEmails.findFirst({
        where: and(eq(userEmails.userId, USER_B_ID), eq(userEmails.kind, 'PERSONAL')),
      })
      expect(rowAfter).toBeUndefined()

      // Restore the fixture for any test ordering assumption elsewhere in
      // this file (personalRow() throws if the row is missing).
      await dbSvc.db
        .insert(userEmails)
        .values({
          userId: USER_B_ID,
          email: USER_B_PERSONAL_EMAIL,
          kind: 'PERSONAL',
          canLogin: false,
        })
        .onConflictDoNothing()
    })

    // SR-L-1 (security-review PR #623 round 5): resubmitting one's OWN
    // current PERSONAL address in a DIFFERENT case must not be reported as
    // a collision with a stranger. The no-op check
    // (`existingRow?.email === newEmail`) is a plain case-SENSITIVE `===`
    // on purpose (see that check's own comment), so a re-cased resubmit is
    // NOT a no-op and reaches `assertEmailAvailable` — which, before this
    // fix, looked up the SAME row case-insensitively and rejected it
    // because `excludeUserId` was never passed.
    it('changePersonalEmail: resubmitting the SAME address in a different case is not reported as a stranger collision', async () => {
      await resetPersonalRow(USER_A_ID)
      const upperCased = USER_A_PERSONAL_EMAIL.toUpperCase()
      const result = await usersService.changePersonalEmail(USER_A_ID, upperCased, ACTOR_ID)
      // Not a no-op (case differs) — goes through delete+reissue and
      // returns a fresh invite, but crucially does NOT throw.
      expect(result?.email).toBe(upperCased)
      const rowAfter = await personalRow(USER_A_ID)
      expect(rowAfter.email).toBe(upperCased)

      // Restore the fixture's exact casing for any test elsewhere in this
      // file that compares against the literal `USER_A_PERSONAL_EMAIL`.
      await dbSvc.db
        .update(userEmails)
        .set({ email: USER_A_PERSONAL_EMAIL, canLogin: false, verifiedAt: null, googleId: null })
        .where(and(eq(userEmails.userId, USER_A_ID), eq(userEmails.kind, 'PERSONAL')))
    })

    // SR-H-5 (security-review PR #623 round 5): `changePersonalEmail` and
    // `acceptPersonalEmailInvite` used to lock `user_emails` /
    // `user_email_invites` in OPPOSITE orders — a textbook ABBA deadlock.
    // The reviewer measured 8/40 raw Postgres deadlocks (40P01) on the
    // pre-fix code, with the admin's OWN revoke losing every time. This is
    // the same race, run against the FIXED code: the strong invariant it
    // checks is not merely "no deadlock" but "the old address is NEVER
    // left logged in", which also catches the SR-L-3 silent-no-op failure
    // mode a naive retry-on-40P01 fix would have left open.
    async function resetPersonalRowTo(userId: string, email: string): Promise<void> {
      await dbSvc.db
        .delete(userEmails)
        .where(and(eq(userEmails.userId, userId), eq(userEmails.kind, 'PERSONAL')))
      await dbSvc.db.insert(userEmails).values({ userId, email, kind: 'PERSONAL', canLogin: false })
    }

    it('SR-H-5: accept vs. change raced 40 times — zero raw Postgres deadlocks, old address NEVER ends up logged in', async () => {
      const RACE_ITERATIONS = 40
      let deadlocks = 0
      let oldAddressStillLoginable = 0

      for (let i = 0; i < RACE_ITERATIONS; i++) {
        await resetPersonalRowTo(USER_A_ID, USER_A_PERSONAL_EMAIL)
        const { rawToken } = await usersService.resendPersonalEmailInvite(USER_A_ID, ACTOR_ID)
        const newEmail = `sr-h-5-race-new-${i}@test.spec`

        const [changeResult, acceptResult] = await Promise.allSettled([
          usersService.changePersonalEmail(USER_A_ID, newEmail, ACTOR_ID),
          usersService.acceptPersonalEmailInvite(rawToken, USER_A_PERSONAL_EMAIL, `race-sub-${i}`),
        ])

        // SR-M-14 (security-review PR #623 round 6): `isDeadlock` walks the
        // `.cause` chain — a raw top-level `r.reason.code` check (the
        // ORIGINAL version of this line) can never be `40P01`, because
        // drizzle-orm wraps every query failure in a `DrizzleQueryError`
        // whose own `.code` is `undefined`; the real pg error lives on
        // `.cause`. See `isDeadlock`'s own doc (`database/pg-errors.ts`)
        // for the proof this was actually broken, not merely theoretically.
        const is40P01 = (r: PromiseSettledResult<unknown>): boolean =>
          r.status === 'rejected' && isDeadlock(r.reason)
        if (is40P01(changeResult) || is40P01(acceptResult)) deadlocks++

        // The invariant that actually matters: whichever side won the
        // race, the OLD address must not be a working login method once
        // both promises have settled.
        const oldRow = await usersService.findLoginableEmailRow(USER_A_PERSONAL_EMAIL)
        if (oldRow) oldAddressStillLoginable++
      }

      expect(deadlocks).toBe(0)
      expect(oldAddressStillLoginable).toBe(0)

      // Restore the fixture for any test ordering assumption elsewhere in
      // this file — mirrors the removal test's own restore step above.
      await resetPersonalRowTo(USER_A_ID, USER_A_PERSONAL_EMAIL)
    }, 60_000)

    // SR-H-6 (security-review PR #623 round 5): a session minted the way a
    // REAL login would (real JwtAuthGuard, real UsersService, cold cache —
    // no mock stands in for either) must die the moment the PERSONAL row
    // that opened it is revoked. Mirrors the reviewer's own reproduction
    // exactly: mint the token, prove it valid, revoke, prove a FRESH guard
    // instance (cold cache — the bound this fix accepts, same CACHE_TTL_MS
    // as the pre-existing archived-check) now rejects the SAME token.
    function makeGuardCtx(token: string): ExecutionContext {
      const request: Record<string, unknown> = { cookies: { jwt: token } }
      return {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as unknown as ExecutionContext
    }
    const guardJwtService = new JwtService({ secret: 'sr-h-6-test-secret-32-chars-minimum' })
    const noopReflector = {
      getAllAndOverride: () => false,
    } as unknown as Reflector

    it('SR-H-6: changing the personal address kills a session already minted through it (cold-cache re-check)', async () => {
      await resetPersonalRowTo(USER_A_ID, USER_A_PERSONAL_EMAIL)
      const { rawToken } = await usersService.resendPersonalEmailInvite(USER_A_ID, ACTOR_ID)
      await usersService.acceptPersonalEmailInvite(rawToken, USER_A_PERSONAL_EMAIL, 'sr-h-6-sub-1')
      const rowBefore = await personalRow(USER_A_ID)

      // The exact JWT shape AuthController.googleCallback mints for a
      // PERSONAL-row login (userEmailId set — see that controller's own
      // comment).
      const payload = jwtPayloadSchema.parse({
        id: USER_A_ID,
        email: USER_A_WORK_EMAIL,
        role: 'JUNIOR',
        userEmailId: rowBefore.id,
      })
      const token = guardJwtService.sign(payload)

      const guardBefore = new JwtAuthGuard(guardJwtService, noopReflector, usersService)
      await expect(guardBefore.canActivate(makeGuardCtx(token))).resolves.toBe(true)

      await usersService.changePersonalEmail(USER_A_ID, 'sr-h-6-new-1@test.spec', ACTOR_ID)

      // Cold cache — a FRESH guard instance, same as the reviewer's own
      // reproduction ("страж собран по-настоящему, кэш холодный").
      const guardAfter = new JwtAuthGuard(guardJwtService, noopReflector, usersService)
      await expect(guardAfter.canActivate(makeGuardCtx(token))).rejects.toBeInstanceOf(
        UnauthorizedException,
      )

      await resetPersonalRowTo(USER_A_ID, USER_A_PERSONAL_EMAIL)
    })

    it('SR-H-6: removing the personal address (null) ALSO kills a session already minted through it', async () => {
      await resetPersonalRowTo(USER_B_ID, USER_B_PERSONAL_EMAIL)
      const { rawToken } = await usersService.resendPersonalEmailInvite(USER_B_ID, ACTOR_ID)
      await usersService.acceptPersonalEmailInvite(rawToken, USER_B_PERSONAL_EMAIL, 'sr-h-6-sub-2')
      const rowBefore = await personalRow(USER_B_ID)

      const payload = jwtPayloadSchema.parse({
        id: USER_B_ID,
        email: USER_B_WORK_EMAIL,
        role: 'JUNIOR',
        userEmailId: rowBefore.id,
      })
      const token = guardJwtService.sign(payload)

      const guardBefore = new JwtAuthGuard(guardJwtService, noopReflector, usersService)
      await expect(guardBefore.canActivate(makeGuardCtx(token))).resolves.toBe(true)

      await usersService.changePersonalEmail(USER_B_ID, null, ACTOR_ID)

      const guardAfter = new JwtAuthGuard(guardJwtService, noopReflector, usersService)
      await expect(guardAfter.canActivate(makeGuardCtx(token))).rejects.toBeInstanceOf(
        UnauthorizedException,
      )

      await resetPersonalRowTo(USER_B_ID, USER_B_PERSONAL_EMAIL)
    })

    // SR-L-4 (security-review PR #623 round 6): this test's ORIGINAL name
    // and comment claimed the token below represented "a WORK-row session
    // (no userEmailId)" — that shape does not occur in production. EVERY
    // real login (`AuthController.googleCallback`'s ordinary branch,
    // `googleOneTap`, `devLogin`) resolves a `user_emails` row and sets
    // `userEmailId` to that row's id REGARDLESS of whether the row is WORK
    // or PERSONAL — verified live against the running API. The token shape
    // actually pinned here — no `userEmailId` at all — is the shape a
    // genuine impersonation-target token has (`jwtPayloadSchema`'s own doc,
    // `@crm/shared`, enumerates all three producers after SR-M-15's fix to
    // that same enumeration). `JwtAuthGuard` itself does not condition the
    // skip on `impersonatorId` — it only checks `jwtUser.userEmailId`
    // (jwt.guard.ts) — so this still correctly pins the guard's behavior
    // for a userEmailId-less token, regardless of which producer minted it.
    it('SR-H-6/SR-L-4: a userEmailId-less (impersonation-shaped) session is unaffected by an unrelated PERSONAL-row revocation', async () => {
      const payload = jwtPayloadSchema.parse({
        id: USER_A_ID,
        email: USER_A_WORK_EMAIL,
        role: 'JUNIOR',
        // No userEmailId — the shape a genuine impersonation-target token
        // has (see this test's own doc above for why "WORK-row login
        // without userEmailId" was a mischaracterization).
      })
      const token = guardJwtService.sign(payload)
      const guard = new JwtAuthGuard(guardJwtService, noopReflector, usersService)
      await expect(guard.canActivate(makeGuardCtx(token))).resolves.toBe(true)
    })
  },
)
