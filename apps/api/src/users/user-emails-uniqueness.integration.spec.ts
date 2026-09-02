/**
 * user_emails cross-kind uniqueness — real-Postgres integration.
 * task-user-emails-dual-login, spec §4.4/§5.
 *
 * The question `security-review` is asked to answer on this PR, verbatim
 * from the spec: "может ли один адрес привести к двум учётным записям"
 * (can one address lead to two accounts). This file answers it twice —
 * once through the application layer (`UsersService.createUser`'s
 * pre-check, `assertEmailAvailable`, which turns the collision into a
 * clean 409) and once through the schema itself (the DB unique index,
 * which is the ACTUAL guarantee — the application check is only there so
 * the failure is a readable ConflictException instead of a raw 23505).
 *
 * Drives the REAL UsersService against real Postgres — no mocked DB layer,
 * per the same "mocked-guards give false confidence" lesson the auth
 * integration specs already follow (feedback_mocked_e2e_guards).
 *
 * DB-SKIP-GUARD: describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is
 * unset (reports SKIPPED, not silently-passed-with-no-assertions).
 *
 * SEED namespace: a17a0003-****.
 */

import { ConflictException } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '../database/schema'
import { userEmails, users } from '../database/schema'
import { DatabaseService } from '../database/database.service'
import { UsersService } from './users.service'
import { hasDatabaseUrl } from '../test/require-real-db'

const EXISTING_USER_ID = 'a17a0003-0000-0000-0000-000000000001'
const EXISTING_WORK_EMAIL = 'uniq-existing-work@test.spec'
const EXISTING_PERSONAL_EMAIL = 'uniq-existing-personal@test.spec'

/** Alternates the case of every letter — same address, different case, every time. */
function mixedCase(email: string): string {
  return email
    .split('')
    .map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase()))
    .join('')
}

describe.skipIf(!hasDatabaseUrl())(
  'user_emails cross-kind uniqueness (§4.4) — real DB integration',
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
          '[user-emails-uniqueness integration] FAILED — no DB at DATABASE_URL (CI unit job)',
        )
      }

      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(pool, { schema })
      dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, {
        pool,
        db,
      })

      // createUser (JUNIOR path, the branch every case below exercises) only
      // touches `this.db` and `this.auditLogService.record(...)` — the
      // remaining constructor deps (access/tos/team-audit/project-audit/
      // teams) are never reached for a JUNIOR with no project, so a stub is
      // sufficient (same minimal-construction pattern as the auth
      // integration specs' UsersService instance). `inviteMailer` — added
      // task-user-emails-invite: `createUser` now calls
      // `this.inviteMailer.sendInvite(...)` (best-effort, after the tx
      // commits) whenever `data.personalEmail` is set, which several cases
      // below exercise — stubbed so that call is a no-op rather than a
      // `Cannot read properties of undefined` crash.
      usersService = Object.assign(Object.create(UsersService.prototype) as UsersService, {
        db: dbSvc,
        auditLogService: { record: vi.fn().mockResolvedValue(undefined) },
        inviteMailer: { sendInvite: vi.fn().mockResolvedValue(undefined) },
      })

      // ── Seed: one existing user with BOTH a work and a personal address ──
      await db
        .insert(users)
        .values({
          id: EXISTING_USER_ID,
          email: EXISTING_WORK_EMAIL,
          displayName: 'Uniqueness Existing',
          role: 'JUNIOR',
        })
        .onConflictDoNothing()
      await db
        .insert(userEmails)
        .values([
          { userId: EXISTING_USER_ID, email: EXISTING_WORK_EMAIL, kind: 'WORK', canLogin: true },
          {
            userId: EXISTING_USER_ID,
            email: EXISTING_PERSONAL_EMAIL,
            kind: 'PERSONAL',
            canLogin: false,
          },
        ])
        .onConflictDoNothing()
    }, 30_000)

    afterAll(async () => {
      try {
        // Sweep every persona this file might have created (existing + any
        // that a test attempted — successful attempts get a real UUID from
        // Postgres, so we sweep by email prefix instead of a fixed id list).
        const rows = await dbSvc.db
          .select({ id: users.id })
          .from(users)
          .where(
            inArray(users.email, [
              EXISTING_WORK_EMAIL,
              'uniq-new-user-a@test.spec',
              'uniq-new-user-b@test.spec',
            ]),
          )
        const ids = rows.map((r) => r.id)
        if (ids.length > 0) {
          // user_emails cascade-deletes with its users row (FK ON DELETE CASCADE).
          await dbSvc.db.delete(users).where(inArray(users.id, ids))
        }
      } catch {
        // Non-fatal cleanup failure — do not mask test results.
      }
      await pool?.end()
    }, 15_000)

    it('rejects a new user whose WORK email equals an existing PERSONAL address — no account created', async () => {
      await expect(
        usersService.createUser({
          email: EXISTING_PERSONAL_EMAIL, // collides with EXISTING_USER's PERSONAL row
          displayName: 'Attacker A',
          role: 'JUNIOR',
          actorRole: 'ADMIN',
          actorId: 'actor-test-id',
        }),
      ).rejects.toBeInstanceOf(ConflictException)

      // No half-created account: no users row, no user_emails row, for the
      // attempted email.
      const userRow = await dbSvc.db.query.users.findFirst({
        where: eq(users.email, EXISTING_PERSONAL_EMAIL),
      })
      expect(userRow).toBeUndefined()
      const emailRows = await dbSvc.db
        .select()
        .from(userEmails)
        .where(eq(userEmails.email, EXISTING_PERSONAL_EMAIL))
      // Exactly the ONE original PERSONAL row from beforeAll — the rejected
      // attempt added nothing.
      expect(emailRows).toHaveLength(1)
      expect(emailRows[0]?.userId).toBe(EXISTING_USER_ID)
    })

    it('rejects a new user whose PERSONAL email equals an existing WORK address — no account created', async () => {
      await expect(
        usersService.createUser({
          email: 'uniq-new-user-a@test.spec',
          personalEmail: EXISTING_WORK_EMAIL, // collides with EXISTING_USER's WORK row
          displayName: 'Attacker B',
          role: 'JUNIOR',
          actorRole: 'ADMIN',
          actorId: 'actor-test-id',
        }),
      ).rejects.toBeInstanceOf(ConflictException)

      // Rejected BEFORE the users insert — the work email address for this
      // attempt was never persisted either (both-or-nothing).
      const userRow = await dbSvc.db.query.users.findFirst({
        where: eq(users.email, 'uniq-new-user-a@test.spec'),
      })
      expect(userRow).toBeUndefined()
    })

    it('a genuinely distinct email + personalEmail pair is accepted — both rows land correctly', async () => {
      const created = await usersService.createUser({
        email: 'uniq-new-user-b@test.spec',
        personalEmail: 'uniq-new-user-b-personal@test.spec',
        displayName: 'Clean New User',
        role: 'JUNIOR',
        actorRole: 'ADMIN',
        actorId: 'actor-test-id',
      })

      const workRow = await dbSvc.db.query.userEmails.findFirst({
        where: eq(userEmails.email, 'uniq-new-user-b@test.spec'),
      })
      expect(workRow?.userId).toBe(created.id)
      expect(workRow?.kind).toBe('WORK')
      expect(workRow?.canLogin).toBe(true)

      const personalRow = await dbSvc.db.query.userEmails.findFirst({
        where: eq(userEmails.email, 'uniq-new-user-b-personal@test.spec'),
      })
      expect(personalRow?.userId).toBe(created.id)
      expect(personalRow?.kind).toBe('PERSONAL')
      // Default — NOT a login method until an invite is accepted (§5, next task).
      expect(personalRow?.canLogin).toBe(false)

      // Cleanup for this one persona now (not swept by the users.email IN-list
      // in afterAll, since the id list there is keyed off email, not id —
      // actually it IS in that list, so afterAll handles it; this direct
      // delete makes the test self-contained even if run in isolation).
      await dbSvc.db.delete(users).where(eq(users.id, created.id))
    })

    it('DB-level backstop: a raw duplicate-email INSERT into user_emails is rejected by the unique index (23505), independent of application code', async () => {
      // This is the ACTUAL structural guarantee (§4.4 module comment on
      // schema.ts) — the application-level assertEmailAvailable check above
      // is only a friendlier error message layered on top of this.
      await expect(
        pool.query(`INSERT INTO user_emails (user_id, email, kind) VALUES ($1, $2, 'WORK')`, [
          EXISTING_USER_ID,
          EXISTING_PERSONAL_EMAIL,
        ]),
      ).rejects.toMatchObject({ code: '23505' })
    })

    // ── SR-H-1 (security-review PR #623, HIGH) — case-insensitivity ──────
    //
    // Reproduces the exact scenario the finding was proven with: mail is
    // case-insensitive, `varchar` equality was not. Bob/Alice/Carol below
    // mirror the reviewer's own persona names for direct traceability.

    it('SR-H-1: a PERSONAL email differing only by case from an existing PERSONAL address is rejected (Bob=Alice@corp.com)', async () => {
      // EXISTING_PERSONAL_EMAIL is already lowercase — this is
      // "alice@corp.com" already registered as EXISTING_USER's PERSONAL row.
      await expect(
        usersService.createUser({
          email: 'uniq-bob@test.spec',
          personalEmail: mixedCase(EXISTING_PERSONAL_EMAIL), // e.g. "Uniq-Existing-Personal@Test.Spec" — same address, different case
          displayName: 'Bob (case-collision attempt)',
          role: 'JUNIOR',
          actorRole: 'ADMIN',
          actorId: 'actor-test-id',
        }),
      ).rejects.toBeInstanceOf(ConflictException)

      const userRow = await dbSvc.db.query.users.findFirst({
        where: eq(users.email, 'uniq-bob@test.spec'),
      })
      expect(userRow).toBeUndefined()
    })

    it('SR-H-1: a SECOND, differently-cased collision against the same address is ALSO rejected (Carol=ALICE@CORP.COM)', async () => {
      await expect(
        usersService.createUser({
          email: 'uniq-carol@test.spec',
          personalEmail: EXISTING_PERSONAL_EMAIL.toUpperCase(),
          displayName: 'Carol (case-collision attempt)',
          role: 'JUNIOR',
          actorRole: 'ADMIN',
          actorId: 'actor-test-id',
        }),
      ).rejects.toBeInstanceOf(ConflictException)

      const userRow = await dbSvc.db.query.users.findFirst({
        where: eq(users.email, 'uniq-carol@test.spec'),
      })
      expect(userRow).toBeUndefined()
    })

    it('SR-H-1: a NEW WORK email differing only by case from an existing PERSONAL address is rejected (the account-takeover direction)', async () => {
      // The specific scenario the review named as the sharpest edge: a new
      // user's WORK email (always canLogin=true) equal, case-insensitively,
      // to someone else's PERSONAL address — must not silently mint a
      // login-enabled row for the same mailbox.
      await expect(
        usersService.createUser({
          email: EXISTING_PERSONAL_EMAIL.toUpperCase(),
          displayName: 'Takeover attempt',
          role: 'JUNIOR',
          actorRole: 'ADMIN',
          actorId: 'actor-test-id',
        }),
      ).rejects.toBeInstanceOf(ConflictException)

      const conflictRows = await dbSvc.db
        .select()
        .from(userEmails)
        .where(eq(userEmails.email, EXISTING_PERSONAL_EMAIL))
      // Still exactly the one original row — no login-enabled duplicate landed.
      expect(conflictRows).toHaveLength(1)
      expect(conflictRows[0]?.canLogin).toBe(false)
    })

    it('SR-H-1: login lookup finds a WORK row regardless of the case used to sign in', async () => {
      // findLoginableUserByEmail must fold case too — an OAuth provider or a
      // typed-in dev-login attempt is not guaranteed to echo back the exact
      // case the address was stored in.
      const found = await usersService.findLoginableUserByEmail(EXISTING_WORK_EMAIL.toUpperCase())
      expect(found?.id).toBe(EXISTING_USER_ID)
    })

    // ── SR-M-2 (security-review PR #623, MED) ─────────────────────────────
    //
    // assertEmailAvailable's excludeUserId exception correctly lets a write
    // through when the ONLY conflicting row belongs to the SAME user (e.g.
    // re-saving an unchanged email) — but it must not, and does not, excuse
    // a collision with a DIFFERENT row of that SAME user: setting one's own
    // WORK address equal to one's own PERSONAL address still hits the
    // global unique index (not scoped by kind). That write must fail
    // cleanly (409), not crash (500), and must fully roll back — the
    // ORIGINAL work address keeps working, the PERSONAL row is untouched.

    it("SR-M-2: admin setting a user's WORK email to that SAME user's own PERSONAL email is rejected cleanly, not a raw 500 — and rolls back completely", async () => {
      await expect(
        usersService.adminUpdateUser(EXISTING_USER_ID, { email: EXISTING_PERSONAL_EMAIL }, null),
      ).rejects.toBeInstanceOf(ConflictException)

      // Rollback verification: `users.email` still has the ORIGINAL
      // address — upsertWorkEmail's UPDATE was reverted along with it in
      // the same transaction, not left half-applied.
      const userRow = await dbSvc.db.query.users.findFirst({
        where: eq(users.id, EXISTING_USER_ID),
      })
      expect(userRow?.email).toBe(EXISTING_WORK_EMAIL)

      // The PERSONAL row is completely untouched by the failed attempt.
      const personalRow = await dbSvc.db.query.userEmails.findFirst({
        where: eq(userEmails.email, EXISTING_PERSONAL_EMAIL),
      })
      expect(personalRow?.userId).toBe(EXISTING_USER_ID)
      expect(personalRow?.kind).toBe('PERSONAL')

      // The ORIGINAL work address still logs in — the whole point of "rolls
      // back completely" is that this keeps working after the failed edit.
      const stillLoginable = await usersService.findLoginableUserByEmail(EXISTING_WORK_EMAIL)
      expect(stillLoginable?.id).toBe(EXISTING_USER_ID)
    })
  },
)
