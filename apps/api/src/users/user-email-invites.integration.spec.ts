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
 *   - resending gates the OLD token (overwritten hash — NotFoundException)
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
} from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../database/schema'
import { userEmailInvites, userEmails, users } from '../database/schema'
import { DatabaseService } from '../database/database.service'
import { UsersService } from './users.service'
import { hashInviteToken } from './invite-token.util'
import { hasDatabaseUrl } from '../test/require-real-db'

const USER_A_ID = 'a17a0004-0000-0000-0000-000000000001'
const USER_A_WORK_EMAIL = 'invite-user-a-work@test.spec'
const USER_A_PERSONAL_EMAIL = 'invite-user-a-personal@test.spec'

const USER_B_ID = 'a17a0004-0000-0000-0000-000000000002'
const USER_B_WORK_EMAIL = 'invite-user-b-work@test.spec'
const USER_B_PERSONAL_EMAIL = 'invite-user-b-personal@test.spec'

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

      // resendPersonalEmailInvite / acceptPersonalEmailInvite only touch
      // `this.db` — no audit log, no team/project services, no mailer (the
      // controller sends the email, not the service — see
      // UsersController.resendPersonalEmailInvite).
      usersService = Object.assign(Object.create(UsersService.prototype) as UsersService, {
        db: dbSvc,
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
      const { rawToken } = await usersService.resendPersonalEmailInvite(USER_A_ID)

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
      const { rawToken } = await usersService.resendPersonalEmailInvite(USER_A_ID)

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
      const { rawToken: tokenA } = await usersService.resendPersonalEmailInvite(USER_A_ID)
      const { rawToken: tokenB } = await usersService.resendPersonalEmailInvite(USER_B_ID)

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

      // And A's token cannot be reused to open B's row via a mismatched
      // address — the row a token resolves to is fixed at issue time
      // (FK on user_email_id), not something the caller can redirect.
      await expect(
        usersService.acceptPersonalEmailInvite(tokenA, USER_B_PERSONAL_EMAIL, 'google-sub-b-1'),
      ).rejects.toBeInstanceOf(ConflictException) // already used (by A's own accept above)
    })

    it('resending gates the OLD token — old raw token rejected (NotFoundException), new one works', async () => {
      await resetPersonalRow(USER_A_ID)
      const { rawToken: firstToken } = await usersService.resendPersonalEmailInvite(USER_A_ID)
      const { rawToken: secondToken } = await usersService.resendPersonalEmailInvite(USER_A_ID)
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
      const { rawToken } = await usersService.resendPersonalEmailInvite(USER_A_ID)
      await usersService.acceptPersonalEmailInvite(
        rawToken,
        USER_A_PERSONAL_EMAIL,
        'google-sub-a-5',
      )

      await expect(usersService.resendPersonalEmailInvite(USER_A_ID)).rejects.toBeInstanceOf(
        ConflictException,
      )
    })
  },
)
