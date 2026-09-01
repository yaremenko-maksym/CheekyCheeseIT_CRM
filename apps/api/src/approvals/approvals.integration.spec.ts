import { randomUUID } from 'crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ConflictException, NotFoundException } from '@nestjs/common'
import { ApprovalsService } from './approvals.service'
import { DatabaseService } from '../database/database.service'
import { uniqueViolationConstraint } from '../database/pg-errors'
import { approvals, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * The CONSTRAINT name of a Postgres CHECK violation (SQLSTATE 23514) in
 * `err`'s cause chain, mirroring `uniqueViolationConstraint` — drizzle-orm
 * wraps the driver's error, so `.code`/`.constraint` live on `.cause`, not on
 * the top-level `DrizzleQueryError`.
 */
function checkViolationConstraint(err: unknown): string | null {
  let cur: unknown = err
  for (let depth = 0; cur != null && depth < 8; depth += 1) {
    const candidate = cur as { code?: unknown; constraint?: unknown }
    if (candidate.code === '23514')
      return typeof candidate.constraint === 'string' ? candidate.constraint : ''
    cur = (cur as { cause?: unknown }).cause
  }
  return null
}

/**
 * task 3 of docs/superpowers/specs/2026-09-01-notifications-and-confirmations-design.md
 * — ApprovalsService against a real Postgres.
 *
 * WHY a real database is not optional here: every invariant this task exists
 * to prove ("Доказательство" in the task) is a multi-row DB transaction —
 * partial agreement, one rejection superseding its siblings, re-proposal
 * superseding an old generation, the DB CHECK rejecting a blank rejection
 * reason, the partial unique index rejecting a duplicate live row. Stryker
 * cannot execute this file at all
 * (`.claude/rules/common/mutation-gate-integration-specs.md`) — the pure
 * branches (Zod validation, getStatus's aggregation) are covered separately
 * by `approvals.service.spec.ts`, which is what the mutation gate sees.
 *
 * Run against a dedicated scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa_approvals \
 *     pnpm --filter @crm/api exec vitest run approvals.integration.spec
 */

const SENIOR_ID = 'a9000000-0000-4000-a000-000000000001'
const DROP_ID = 'a9000000-0000-4000-a000-000000000002'
const ADMIN_ID = 'a9000000-0000-4000-a000-000000000003'
const TEST_USER_IDS = [SENIOR_ID, DROP_ID, ADMIN_ID]

const SUBJECT_TYPE = 'TEST_SUBJECT'

let pool: Pool
let dbSvc: DatabaseService
let svc: ApprovalsService

function freshSubjectId() {
  return randomUUID()
}

describe.skipIf(!hasDatabaseUrl())('ApprovalsService — against real Postgres', () => {
  beforeAll(async () => {
    const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const which = await probe.query('SELECT current_database() AS db')
    if (which.rows[0]?.db === 'crm_db') {
      await probe.end()
      throw new Error('[approvals] REFUSING to run against the live crm_db')
    }
    const check = await probe.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'approvals' LIMIT 1`,
    )
    await probe.end()
    if (check.rowCount === 0) {
      throw new Error(
        '[approvals] FAILED — schema not migrated (no `approvals` table). Run ' +
          '`pnpm --filter @crm/api db:push` against this DATABASE_URL first.',
      )
    }

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, {
      pool,
      db,
    })
    svc = new ApprovalsService(dbSvc)

    await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    await dbSvc.db.insert(users).values([
      { id: SENIOR_ID, email: 'approvals-senior@test.spec', displayName: 'Senior', role: 'SENIOR' },
      { id: DROP_ID, email: 'approvals-drop@test.spec', displayName: 'Drop', role: 'DROP' },
      { id: ADMIN_ID, email: 'approvals-admin@test.spec', displayName: 'Admin', role: 'ADMIN' },
    ])
  })

  beforeEach(async () => {
    // Every test proposes against its own fresh subjectId, so no cross-test
    // cleanup of `approvals` rows is needed between tests — only at teardown.
  })

  afterAll(async () => {
    if (dbSvc) {
      await dbSvc.db.delete(approvals).where(inArray(approvals.approverUserId, TEST_USER_IDS))
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    }
    await pool?.end()
  })

  // ---------------------------------------------------------------------------
  // Proof 1 — partial agreement expressed with no extra field
  // ---------------------------------------------------------------------------
  it('partial agreement: one approver APPROVED, the other still PENDING, no extra field', async () => {
    const subjectId = freshSubjectId()
    await svc.propose({
      subjectType: SUBJECT_TYPE,
      subjectId,
      approverUserIds: [SENIOR_ID, DROP_ID],
      proposedByUserId: ADMIN_ID,
    })

    await svc.approve({ subjectType: SUBJECT_TYPE, subjectId, approverUserId: SENIOR_ID })

    const live = await svc.listLive(SUBJECT_TYPE, subjectId)
    expect(live).toHaveLength(2)
    const senior = live.find((r) => r.approverUserId === SENIOR_ID)
    const drop = live.find((r) => r.approverUserId === DROP_ID)
    expect(senior?.status).toBe('APPROVED')
    expect(senior?.decidedAt).not.toBeNull()
    expect(drop?.status).toBe('PENDING')
    expect(drop?.decidedAt).toBeNull()

    // Aggregate is still PENDING — the subject is not confirmed until BOTH agree.
    expect(await svc.getStatus(SUBJECT_TYPE, subjectId)).toBe('PENDING')
  })

  // ---------------------------------------------------------------------------
  // Proof 2 — one rejection voids the whole proposal
  // ---------------------------------------------------------------------------
  it('one rejection supersedes every other live row for the subject — including an already-APPROVED one', async () => {
    const subjectId = freshSubjectId()
    await svc.propose({
      subjectType: SUBJECT_TYPE,
      subjectId,
      approverUserIds: [SENIOR_ID, DROP_ID],
      proposedByUserId: ADMIN_ID,
    })
    await svc.approve({ subjectType: SUBJECT_TYPE, subjectId, approverUserId: SENIOR_ID })

    const rejected = await svc.reject({
      subjectType: SUBJECT_TYPE,
      subjectId,
      approverUserId: DROP_ID,
      reason: 'Не согласен с условиями',
    })
    expect(rejected.status).toBe('REJECTED')
    expect(rejected.rejectionReason).toBe('Не согласен с условиями')

    // The live generation now contains ONLY the rejected row — the earlier
    // APPROVED sibling is superseded (annulled, not deleted — proof 3 checks it
    // is still visible in full history).
    const live = await svc.listLive(SUBJECT_TYPE, subjectId)
    expect(live).toHaveLength(1)
    expect(live[0]?.approverUserId).toBe(DROP_ID)
    expect(live[0]?.status).toBe('REJECTED')

    expect(await svc.getStatus(SUBJECT_TYPE, subjectId)).toBe('REJECTED')

    // The quenched sibling can no longer be acted upon — it reads as "gone",
    // not as "still pending" (proof 5: a superseded row does not count).
    await expect(
      svc.approve({ subjectType: SUBJECT_TYPE, subjectId, approverUserId: SENIOR_ID }),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  // ---------------------------------------------------------------------------
  // CR-H-1 (code-review, PR #624) — two approvers rejecting the SAME subject
  // at the same moment must not deadlock. Before the lock-order fix,
  // reject() locked its OWN row first and only then cascade-locked every
  // sibling — two concurrent reject() calls from different approvers of the
  // same subject acquired those two locks in OPPOSITE order (an ABBA
  // inversion), which the reviewer reproduced as a real Postgres deadlock
  // (40P01) against a scratch DB. `lockLiveRows`'s `ORDER BY id FOR UPDATE`
  // makes both callers acquire locks in the SAME order, so the race now has
  // a well-defined outcome instead of a coin-flip chance of a raw 500.
  // ---------------------------------------------------------------------------
  it('two approvers rejecting the same subject at the same time never deadlocks — one wins, the other finds its row already superseded', async () => {
    const subjectId = freshSubjectId()
    await svc.propose({
      subjectType: SUBJECT_TYPE,
      subjectId,
      approverUserIds: [SENIOR_ID, DROP_ID],
      proposedByUserId: ADMIN_ID,
    })

    const results = await Promise.allSettled([
      svc.reject({
        subjectType: SUBJECT_TYPE,
        subjectId,
        approverUserId: SENIOR_ID,
        reason: 'Senior отказывается',
      }),
      svc.reject({
        subjectType: SUBJECT_TYPE,
        subjectId,
        approverUserId: DROP_ID,
        reason: 'Drop отказывается',
      }),
    ])

    // Neither settled outcome may be a raw driver error — a deadlock would
    // surface as SQLSTATE 40P01, not as either of the service's own
    // controlled exceptions. Exactly one side commits its rejection; the
    // other's row was superseded by the first side's cascade before it
    // acquired the lock, so it sees "already gone" — a legitimate
    // NotFoundException, not a crash.
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof svc.reject>>> =>
        r.status === 'fulfilled',
    )
    const settledRejections = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )

    expect(fulfilled).toHaveLength(1)
    expect(fulfilled[0]?.value.status).toBe('REJECTED')

    expect(settledRejections).toHaveLength(1)
    expect(settledRejections[0]?.reason).toBeInstanceOf(NotFoundException)
    expect((settledRejections[0]?.reason as Error).message).toBe(
      'Согласование не найдено или уже погашено',
    )

    // The subject as a whole IS rejected either way (decision #5) — WHICH
    // approver "won" the race is not observable from outside, only that the
    // outcome is well-defined and race-free.
    expect(await svc.getStatus(SUBJECT_TYPE, subjectId)).toBe('REJECTED')
  })

  // ---------------------------------------------------------------------------
  // Proof 3 — re-proposal never rewrites old rows; both attempts stay visible
  // ---------------------------------------------------------------------------
  it('re-proposing after a rejection supersedes the old generation and keeps its history intact', async () => {
    const subjectId = freshSubjectId()
    await svc.propose({
      subjectType: SUBJECT_TYPE,
      subjectId,
      approverUserIds: [SENIOR_ID, DROP_ID],
      proposedByUserId: ADMIN_ID,
    })
    await svc.approve({ subjectType: SUBJECT_TYPE, subjectId, approverUserId: SENIOR_ID })
    await svc.reject({
      subjectType: SUBJECT_TYPE,
      subjectId,
      approverUserId: DROP_ID,
      reason: 'Пересмотрите условия',
    })

    const secondGeneration = await svc.propose({
      subjectType: SUBJECT_TYPE,
      subjectId,
      approverUserIds: [SENIOR_ID, DROP_ID],
      proposedByUserId: ADMIN_ID,
    })
    expect(secondGeneration).toHaveLength(2)
    expect(secondGeneration.every((r) => r.status === 'PENDING')).toBe(true)

    // Live generation is ONLY the new attempt.
    const live = await svc.listLive(SUBJECT_TYPE, subjectId)
    expect(live).toHaveLength(2)
    expect(live.every((r) => r.status === 'PENDING')).toBe(true)
    expect(await svc.getStatus(SUBJECT_TYPE, subjectId)).toBe('PENDING')

    // Full history — no filter — shows BOTH attempts: the first generation's
    // three rows (1 APPROVED, 1 REJECTED with its reason — the sibling that
    // reject() itself superseded IS the approved one) plus the second
    // generation's 2 fresh PENDING rows. Nothing was rewritten.
    const allRows = await dbSvc.db
      .select()
      .from(approvals)
      .where(eq(approvals.subjectId, subjectId))
    expect(allRows).toHaveLength(4)
    const firstGenApproved = allRows.find(
      (r) => r.approverUserId === SENIOR_ID && r.status === 'APPROVED',
    )
    const firstGenRejected = allRows.find(
      (r) => r.approverUserId === DROP_ID && r.status === 'REJECTED',
    )
    expect(firstGenApproved?.supersededAt).not.toBeNull() // annulled by the reject cascade
    expect(firstGenRejected?.supersededAt).not.toBeNull() // annulled by the re-propose
    expect(firstGenRejected?.rejectionReason).toBe('Пересмотрите условия') // reason preserved
  })

  // ---------------------------------------------------------------------------
  // Proof 4 — rejection without a reason is rejected outright
  // ---------------------------------------------------------------------------
  it('rejecting with a blank reason is refused before it ever reaches the DB', async () => {
    const subjectId = freshSubjectId()
    await svc.propose({
      subjectType: SUBJECT_TYPE,
      subjectId,
      approverUserIds: [SENIOR_ID],
      proposedByUserId: ADMIN_ID,
    })

    await expect(
      svc.reject({
        subjectType: SUBJECT_TYPE,
        subjectId,
        approverUserId: SENIOR_ID,
        reason: '   ',
      }),
    ).rejects.toThrow()

    // The row is untouched — still PENDING, not silently half-rejected.
    const live = await svc.listLive(SUBJECT_TYPE, subjectId)
    expect(live[0]?.status).toBe('PENDING')
  })

  it('the DB itself refuses a REJECTED row with a blank reason (ck_approvals_rejection_reason_required)', async () => {
    const subjectId = freshSubjectId()
    let caught: unknown
    try {
      await dbSvc.db.insert(approvals).values({
        subjectType: SUBJECT_TYPE,
        subjectId,
        approverUserId: SENIOR_ID,
        proposedByUserId: ADMIN_ID,
        status: 'REJECTED',
        rejectionReason: null,
        decidedAt: new Date(),
      })
    } catch (err) {
      caught = err
    }
    expect(checkViolationConstraint(caught)).toBe('ck_approvals_rejection_reason_required')
  })

  // ---------------------------------------------------------------------------
  // Proof 5 — a superseded row does not participate in the count
  // ---------------------------------------------------------------------------
  it('getStatus and listLive never see a superseded row, even though it is still in the table', async () => {
    const subjectId = freshSubjectId()
    await svc.propose({
      subjectType: SUBJECT_TYPE,
      subjectId,
      approverUserIds: [SENIOR_ID],
      proposedByUserId: ADMIN_ID,
    })
    await svc.approve({ subjectType: SUBJECT_TYPE, subjectId, approverUserId: SENIOR_ID })
    expect(await svc.getStatus(SUBJECT_TYPE, subjectId)).toBe('APPROVED')

    // Re-propose supersedes the APPROVED row — even though nobody rejected it.
    await svc.propose({
      subjectType: SUBJECT_TYPE,
      subjectId,
      approverUserIds: [SENIOR_ID],
      proposedByUserId: ADMIN_ID,
    })

    // The row is still physically in the table (full history)...
    const allRows = await dbSvc.db
      .select()
      .from(approvals)
      .where(eq(approvals.subjectId, subjectId))
    const oldApproved = allRows.find((r) => r.status === 'APPROVED')
    expect(oldApproved).toBeDefined()
    expect(oldApproved?.supersededAt).not.toBeNull()

    // ...but it does not count: the subject reads as freshly PENDING again,
    // not as "already approved".
    expect(await svc.getStatus(SUBJECT_TYPE, subjectId)).toBe('PENDING')
    const live = await svc.listLive(SUBJECT_TYPE, subjectId)
    expect(live).toHaveLength(1)
    expect(live[0]?.status).toBe('PENDING')
  })

  // ---------------------------------------------------------------------------
  // A subject nobody has ever proposed for.
  // ---------------------------------------------------------------------------
  it('getStatus is NONE before any proposal exists', async () => {
    expect(await svc.getStatus(SUBJECT_TYPE, freshSubjectId())).toBe('NONE')
  })

  // ---------------------------------------------------------------------------
  // Responding twice to the same live row is refused, not silently accepted.
  // ---------------------------------------------------------------------------
  it('approving an already-decided row is refused (ConflictException), not silently accepted', async () => {
    const subjectId = freshSubjectId()
    await svc.propose({
      subjectType: SUBJECT_TYPE,
      subjectId,
      approverUserIds: [SENIOR_ID],
      proposedByUserId: ADMIN_ID,
    })
    await svc.approve({ subjectType: SUBJECT_TYPE, subjectId, approverUserId: SENIOR_ID })

    await expect(
      svc.approve({ subjectType: SUBJECT_TYPE, subjectId, approverUserId: SENIOR_ID }),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  // ---------------------------------------------------------------------------
  // Race guard — the partial unique index backstops the service-level supersede.
  // ---------------------------------------------------------------------------
  it('the partial unique index refuses a second concurrent live row for the same (subject, approver)', async () => {
    const subjectId = freshSubjectId()
    await dbSvc.db.insert(approvals).values({
      subjectType: SUBJECT_TYPE,
      subjectId,
      approverUserId: SENIOR_ID,
      proposedByUserId: ADMIN_ID,
      status: 'PENDING',
    })

    let caught: unknown
    try {
      await dbSvc.db.insert(approvals).values({
        subjectType: SUBJECT_TYPE,
        subjectId,
        approverUserId: SENIOR_ID,
        proposedByUserId: ADMIN_ID,
        status: 'PENDING',
      })
    } catch (err) {
      caught = err
    }
    expect(uniqueViolationConstraint(caught)).toBe('uq_approvals_live_subject_approver')
  })

  // ---------------------------------------------------------------------------
  // listPendingForApprover — the "что от меня ждут" query (position 7 not built
  // here, but the query it will rely on is proven now).
  // ---------------------------------------------------------------------------
  it('listPendingForApprover returns only live PENDING rows for that approver, across subjects', async () => {
    const subjectA = freshSubjectId()
    const subjectB = freshSubjectId()
    await svc.propose({
      subjectType: SUBJECT_TYPE,
      subjectId: subjectA,
      approverUserIds: [DROP_ID],
      proposedByUserId: ADMIN_ID,
    })
    await svc.propose({
      subjectType: SUBJECT_TYPE,
      subjectId: subjectB,
      approverUserIds: [DROP_ID],
      proposedByUserId: ADMIN_ID,
    })
    await svc.approve({ subjectType: SUBJECT_TYPE, subjectId: subjectB, approverUserId: DROP_ID })

    const pending = await svc.listPendingForApprover(DROP_ID)
    const subjectIds = pending.map((r) => r.subjectId)
    expect(subjectIds).toContain(subjectA)
    expect(subjectIds).not.toContain(subjectB)
  })
})
