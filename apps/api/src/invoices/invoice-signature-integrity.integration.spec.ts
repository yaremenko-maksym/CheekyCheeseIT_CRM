/**
 * task-invoice-signature-integrity — integration spec (AC4, + round-2/3
 * security-review closures: HIGH-1, HIGH-2, MED-1, MED-4, MED-B).
 *
 * Deliberately a REAL-Postgres test, not a mock-heavy unit test: AC4 is
 * about an EXTERNAL divergence — does the public /verify endpoint ever show
 * a live `transactions.amount` as "confirmed" when it no longer matches
 * what the counterparty actually signed. A mocked DB harness would just
 * replay whatever the test told it to return and could never demonstrate
 * that. Real PDF generation + a real (in-memory) S3 fake + a real Postgres
 * connection exercise the ACTUAL SQL (partial unique index, voided-row
 * filtering) this fix depends on.
 *
 * Round 2 (PR #600 security review) added three more real-DB-only proofs
 * to this same file, for the same reason each is here and not in the
 * mocked unit spec:
 *   - HIGH-1: executes the shipped migration FILE (not a re-typed snippet)
 *     to prove its backfill closes the legacy NULL-snapshot fallback gap —
 *     a mocked harness cannot run a .sql file at all.
 *   - MED-1: reproduces the void<->sign race via single-threaded async
 *     interleaving (a one-shot S3-download hook) and proves the OUTCOME
 *     (409, no corruption). CORRECTION (round 3, MED-B): this alone does
 *     NOT prove the `FOR UPDATE` lock itself is contested — see the MED-B
 *     test below, added specifically because this one does not (a prior
 *     round's commit message claimed mutation-tally's 61 `NoCoverage`
 *     entries were "covered by the integration spec" without that
 *     qualification; `.claude/rules/common/mutation-gate-integration-specs.md`
 *     is explicit that `NoCoverage` says nothing about whether a covering
 *     test actually EXERCISES the mutated branch under contention).
 *   - MED-4: calls `listInvoices` directly against the real DB, the one
 *     thing the mocked unit spec structurally cannot check (it synthesises
 *     `signedFlag` itself instead of executing the SQL text).
 *
 * Round 3 (PR #600 security review) added two more:
 *   - HIGH-2: executes the shipped migration file again, this time on a
 *     PAYOUT row — the one case where the backfill's source (`tx.amount`)
 *     and the signed source (the aggregated linked-income sum) structurally
 *     differ; the HIGH-1 test above only exercises SALARY, where they are
 *     the same column by construction and could never have caught this.
 *   - MED-B: races `signInvoice`'s own `FOR UPDATE` select against a void
 *     transaction that is deliberately held open (paused mid-transaction
 *     via a spied `documentsService.softDeleteInternal`) — proves real
 *     Postgres row-lock contention, which MED-1's already-committed-by-the-
 *     time-signInvoice-starts race never did.
 *
 * DB-SKIP-GUARD: describe.skipIf(!hasDatabaseUrl()) — reports SKIPPED (not
 * silently-passed with zero assertions) when DATABASE_URL is unset. A
 * DATABASE_URL that is set but unreachable throws in beforeAll (FAILED).
 *
 * Run explicitly (per task-file environment rules):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:<scratch-port>/<scratch-db> \
 *     pnpm --filter @crm/api exec vitest run invoice-signature-integrity.integration.spec
 *
 * Fixtures are created directly in beforeAll (own users + own transactions,
 * random UUIDs) and cleaned up in afterAll — no dependency on any global
 * seed data.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConflictException, NotFoundException } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ConfigService } from '@nestjs/config'
import type { FastifyRequest } from 'fastify'
import type { SessionUser } from '@crm/shared'
import type { Env } from '../config/env'
import type { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import {
  documents,
  invoiceSignatures,
  payoutRequests,
  transactions,
  users,
} from '../database/schema'
import { InvoicesService } from './invoices.service'
import { InvoicePdfService } from './invoice-pdf.service'
import { PdfGenerationService } from '../common/pdf/pdf-generation.service'
import { DocumentsService } from '../documents/documents.service'
import type { S3Service } from '../documents/s3.service'
import type { CompressionService } from '../documents/compression.service'
import type { HrAccessService } from '../common/hr-access.service'
import { NotificationsService } from '../notifications/notifications.service'
import { hasDatabaseUrl } from '../test/require-real-db'

/** In-memory S3 fake — no real bucket needed for this spec. */
class FakeS3Service {
  private store = new Map<string, Buffer>()
  /**
   * MED-1 race test hook (security-review round 2, PR #600). When set,
   * awaited ONCE inside `getObject` right before it returns — this is the
   * ONLY await point in `signInvoice` between it reading the COMPANY
   * signature/document and inserting its own COUNTERPARTY row, so it is
   * where a test can inject a concurrent `voidAndReissueInvoiceForAmountEdit`
   * to land "mid-flight" without any real threads. One-shot: cleared before
   * the hook body runs, so a nested/second `getObject` call inside the
   * injected work (e.g. the reissue's own auto-sign PDF round-trip) never
   * re-triggers it.
   */
  onGetObject: (() => Promise<void>) | null = null
  upload(key: string, body: Buffer): Promise<void> {
    this.store.set(key, body)
    return Promise.resolve()
  }
  async getObject(key: string): Promise<Buffer> {
    const buf = this.store.get(key)
    if (!buf) return Promise.reject(new Error(`FakeS3Service: no object at ${key}`))
    if (this.onGetObject) {
      const hook = this.onGetObject
      this.onGetObject = null
      await hook()
    }
    return buf
  }
  delete(key: string): Promise<void> {
    this.store.delete(key)
    return Promise.resolve()
  }
}

const TAG = 'invsig-integrity'

const sessionOf = (row: {
  id: string
  role: SessionUser['role']
  displayName: string
}): SessionUser => ({
  id: row.id,
  role: row.role,
  displayName: row.displayName,
  email: `${row.id}@x.test`,
  avatarUrl: null,
  seniorSharePercent: 26,
  legalFullName: null,
})

const fakeReq = (ip: string) =>
  ({ ip, headers: { 'user-agent': 'vitest-invsig' } }) as unknown as FastifyRequest

describe.skipIf(!hasDatabaseUrl())(
  'task-invoice-signature-integrity — AC4 real-DB integration',
  () => {
    let pool: Pool
    let db: ReturnType<typeof drizzle<typeof schema>>
    let invoices: InvoicesService
    let fakeS3: FakeS3Service
    let documentsService: DocumentsService

    const ADMIN_ID = randomUUID()
    const JUNIOR_ID = randomUUID() // SALARY counterparty — the AC2-bis leaf case
    const SENIOR_ID = randomUUID() // PAYOUT counterparty — HIGH-2 regression (aggregated income snapshot, structurally != tx.amount)

    beforeAll(async () => {
      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      try {
        await pool.query('SELECT 1')
      } catch {
        throw new Error(
          '[invoice-signature-integrity] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job; run explicitly against a scratch DB per live-db-access.md)',
        )
      }
      db = drizzle(pool, { schema })

      await db
        .insert(users)
        .values([
          {
            id: ADMIN_ID,
            email: `${TAG}-admin@x.test`,
            displayName: 'Admin',
            role: 'ADMIN',
            createdAt: new Date('2020-01-01T00:00:00Z'),
          },
          {
            id: JUNIOR_ID,
            email: `${TAG}-junior@x.test`,
            displayName: 'Junior',
            role: 'JUNIOR',
          },
          {
            id: SENIOR_ID,
            email: `${TAG}-senior@x.test`,
            displayName: 'Senior',
            role: 'SENIOR',
          },
        ])
        .onConflictDoNothing()

      const dbService = { db } as unknown as DatabaseService
      const pdfGen = new PdfGenerationService()
      const invoicePdf = new InvoicePdfService(pdfGen)
      const fakeS3Impl = new FakeS3Service()
      fakeS3 = fakeS3Impl
      documentsService = new DocumentsService(
        dbService,
        fakeS3Impl as unknown as S3Service,
        {} as unknown as CompressionService,
        {} as unknown as HrAccessService,
      )
      const notifications = new NotificationsService(dbService)
      const fakeConfig = {
        get: () => 'https://verify.test',
      } as unknown as ConfigService<Env, true>

      invoices = new InvoicesService(
        dbService,
        invoicePdf,
        documentsService,
        fakeS3Impl as unknown as S3Service,
        notifications,
        fakeConfig,
      )
    }, 60_000)

    afterAll(async () => {
      const txIds = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.createdBy, ADMIN_ID))
      const ids = txIds.map((r) => r.id)
      if (ids.length > 0) {
        await db.delete(invoiceSignatures).where(inArray(invoiceSignatures.transactionId, ids))
        await db.delete(documents).where(inArray(documents.ownerId, [JUNIOR_ID, SENIOR_ID]))
        await db.delete(transactions).where(inArray(transactions.id, ids))
      }
      // payoutRequests rows cascade-delete via seniorId's `onDelete: 'cascade'`
      // FK when SENIOR_ID is removed below — no separate delete needed.
      await db.delete(users).where(inArray(users.id, [ADMIN_ID, JUNIOR_ID, SENIOR_ID]))
      await pool.end()
    }, 30_000)

    /**
     * AC4 core scenario, and AC2-bis closed in the same flow (SALARY is
     * exactly the leaf type AC2-bis identifies as never re-transitioning to
     * PAID on its own — see `reissueInvoiceIfStillPaid`'s doc comment).
     */
    it('void + reissue: a signed SALARY invoice survives an amount edit as a FRESH invoice with the NEW amount; old signatures do not carry over; verify never confirms the stale live amount', async () => {
      const txId = randomUUID()
      await db.insert(transactions).values({
        id: txId,
        type: 'SALARY',
        status: 'PAID',
        amount: '1000',
        currency: 'USD',
        receiverId: JUNIOR_ID,
        createdBy: ADMIN_ID,
      })

      // ---- 1. Auto-create (COMPANY signs) + counterparty signs ----
      await invoices.autoCreateForSalary(txId)
      const signed = await invoices.signInvoice(
        sessionOf({ id: JUNIOR_ID, role: 'JUNIOR', displayName: 'Junior' }),
        txId,
        fakeReq('203.0.113.10'),
      )
      expect(signed.status).toBe('SIGNED')

      const beforeVerify = await invoices.verifyInvoice(txId)
      expect(beforeVerify.status).toBe('SIGNED')
      expect(beforeVerify.amount).toBe('1000.000000')

      const oldCounterpartySig = await db
        .select()
        .from(invoiceSignatures)
        .where(eq(invoiceSignatures.transactionId, txId))
      const oldActiveCount = oldCounterpartySig.filter((s) => s.voidedAt === null).length
      expect(oldActiveCount).toBe(2) // COMPANY + COUNTERPARTY, both active

      // ---- 2. AC2-bis gap, demonstrated directly: void ALONE leaves a
      // still-PAID SALARY row invoice-less, because nothing else will ever
      // re-trigger autoCreate* for it (no cascade, no re-transition). ----
      const voidResult = await invoices.voidInvoiceForAmountEdit(txId, ADMIN_ID)
      expect(voidResult).toEqual({ hadInvoice: true, wasSigned: true })

      const [afterVoidOnly] = await db.select().from(transactions).where(eq(transactions.id, txId))
      expect(afterVoidOnly!.invoiceDocumentId).toBeNull()
      expect(afterVoidOnly!.status).toBe('PAID') // still PAID — the gap PM flagged

      // Public verify must be honest: no document, no confirmation of
      // ANY amount — not the old one, not a live one.
      await expect(invoices.verifyInvoice(txId)).rejects.toThrow(NotFoundException)

      // ---- 3. Simulate task-3's amount edit landing on the now-voided row
      // (any means — direct SQL here, exactly per AC4's "external
      // divergence" framing: this test does not care HOW the amount
      // changed) ----
      await db.update(transactions).set({ amount: '1500' }).where(eq(transactions.id, txId))

      // ---- 4. AC2-bis fix: reissue closes the gap — SALARY is still PAID,
      // so a fresh invoice is generated immediately, with the NEW amount ----
      await invoices.reissueInvoiceIfStillPaid(txId)
      const [afterReissue] = await db.select().from(transactions).where(eq(transactions.id, txId))
      expect(afterReissue!.invoiceDocumentId).not.toBeNull()
      expect(afterReissue!.invoiceDocumentId).not.toBe(afterVoidOnly!.invoiceDocumentId)

      // The freshly-reissued invoice is COMPANY-signed only — NOT
      // COUNTERPARTY-signed. The OLD counterparty signature must not have
      // carried over (it is a HISTORICAL fact about the VOIDED invoice).
      const notYetSigned = await invoices.getInvoice(
        sessionOf({ id: ADMIN_ID, role: 'ADMIN', displayName: 'Admin' }),
        txId,
      )
      expect(notYetSigned.status).toBe('PENDING')
      expect(notYetSigned.amount).toBe('1500.000000')

      await expect(invoices.verifyInvoice(txId)).rejects.toThrow(NotFoundException)

      // security-review round 2 (PR #600, MED-4): listInvoices' status
      // filter is computed via a `voided_at IS NULL`-scoped EXISTS on
      // `invoice_signatures` — unit-tested only against a MOCKED Drizzle
      // layer that never executes the SQL text (invoices.service.spec.ts),
      // so this real-DB assertion is the only thing that can catch the
      // clause being dropped: the freshly-reissued (still-unsigned)
      // invoice must show up as PENDING, and must NOT show up under the
      // SIGNED filter — a stale VOIDED COUNTERPARTY row from the prior
      // invoice generation must not leak forward and report "already
      // signed" for a document nobody has seen yet.
      const pendingList = await invoices.listInvoices(
        sessionOf({ id: ADMIN_ID, role: 'ADMIN', displayName: 'Admin' }),
        { status: 'PENDING' },
      )
      expect(pendingList.some((i) => i.transactionId === txId)).toBe(true)

      const signedList = await invoices.listInvoices(
        sessionOf({ id: ADMIN_ID, role: 'ADMIN', displayName: 'Admin' }),
        { status: 'SIGNED' },
      )
      expect(signedList.some((i) => i.transactionId === txId)).toBe(false)

      // ---- 5. Counterparty re-signs the FRESH invoice — this must
      // succeed (the partial unique index scopes uniqueness to ACTIVE
      // rows only, so a second, unrelated COUNTERPARTY row for the same
      // transaction+role does not collide with the voided one) ----
      const resigned = await invoices.signInvoice(
        sessionOf({ id: JUNIOR_ID, role: 'JUNIOR', displayName: 'Junior' }),
        txId,
        fakeReq('203.0.113.20'),
      )
      expect(resigned.status).toBe('SIGNED')

      // MED-4, round-trip: now that the FRESH invoice is actually signed,
      // listInvoices' SIGNED filter must flip to true for it — closes the
      // loop so the PENDING-side assertion above cannot pass merely by
      // coincidence (e.g. an always-false EXISTS would satisfy BOTH
      // "PENDING contains it" and "SIGNED excludes it" without this).
      const signedListAfterResign = await invoices.listInvoices(
        sessionOf({ id: ADMIN_ID, role: 'ADMIN', displayName: 'Admin' }),
        { status: 'SIGNED' },
      )
      expect(signedListAfterResign.some((i) => i.transactionId === txId)).toBe(true)

      const afterVerify = await invoices.verifyInvoice(txId)
      expect(afterVerify.status).toBe('SIGNED')
      // AC4 core assertion: verify shows the NEW, freshly-signed amount —
      // not because it trusts the live column, but because that IS what
      // this second signature actually attests to.
      expect(afterVerify.amount).toBe('1500.000000')

      // ---- 6. Old (voided) COUNTERPARTY row is still in the DB
      // (audit trail, AC2), but is no longer "the" signature — the new one
      // has a different id and a fresh, un-voided row. ----
      const allSigRows = await db
        .select()
        .from(invoiceSignatures)
        .where(eq(invoiceSignatures.transactionId, txId))
      const voidedRows = allSigRows.filter((s) => s.voidedAt !== null)
      const activeRows = allSigRows.filter((s) => s.voidedAt === null)
      expect(voidedRows.length).toBe(2) // old COMPANY + old COUNTERPARTY
      expect(activeRows.length).toBe(2) // new COMPANY + new COUNTERPARTY
      const activeCounterparty = activeRows.find((s) => s.signerRole === 'COUNTERPARTY')
      expect(activeCounterparty?.amountSnapshot).toBe('1500.000000')
    }, 30_000)

    /**
     * AC3, isolated: even when SOMETHING bypasses the AC2 void path
     * entirely (a bug, a future feature, a manual data fix — exactly the
     * "external divergence, not internal consistency" framing of AC4) and
     * mutates `transactions.amount` on an already-signed row directly, the
     * public verify endpoint must still never surface that live value as
     * "confirmed". This is what makes AC3 true "independent of the AC2
     * choice" — it does not rely on void having been called at all.
     */
    it('AC3 backstop: verify keeps returning the signed snapshot even if a write bypasses the AC2 void path entirely', async () => {
      const txId = randomUUID()
      await db.insert(transactions).values({
        id: txId,
        type: 'SALARY',
        status: 'PAID',
        amount: '800',
        currency: 'USD',
        receiverId: JUNIOR_ID,
        createdBy: ADMIN_ID,
      })

      await invoices.autoCreateForSalary(txId)
      await invoices.signInvoice(
        sessionOf({ id: JUNIOR_ID, role: 'JUNIOR', displayName: 'Junior' }),
        txId,
        fakeReq('203.0.113.30'),
      )

      // Bypass AC2 entirely — raw write, no void call. This is the exact
      // "printed copy says 8000, live says 10000" scenario from the task
      // brief, engineered directly at the DB layer.
      await db.update(transactions).set({ amount: '10000' }).where(eq(transactions.id, txId))

      const verify = await invoices.verifyInvoice(txId)
      // MUST still be the signed amount (800), never the tampered live one.
      expect(verify.amount).toBe('800.000000')
      expect(verify.amount).not.toBe('10000.000000')
    }, 30_000)

    /**
     * HIGH-1 (security-review round 2, PR #600). The migration's DDL adds
     * `amount_snapshot` with NO backfill on its own — every row that was
     * ALREADY an active COUNTERPARTY signature when it first ran would keep
     * `amount_snapshot IS NULL` forever, and `verifyInvoice`'s legacy
     * fallback (`?? tx.amount`) would keep surfacing the LIVE amount for
     * exactly those rows — the one thing AC3 requires it never do
     * "independent of the AC2 choice". This reads and executes the ACTUAL
     * migration file that ships in this PR (never a hand-copied snippet) so
     * a future edit to the backfill's WHERE clause is caught here too.
     */
    it('HIGH-1: the migration file backfills a legacy NULL-snapshot row from live tx.amount, closing the fallback gap for a LATER divergence', async () => {
      const txId = randomUUID()
      await db.insert(transactions).values({
        id: txId,
        type: 'SALARY',
        status: 'PAID',
        amount: '1000',
        currency: 'USD',
        receiverId: JUNIOR_ID,
        createdBy: ADMIN_ID,
      })

      await invoices.autoCreateForSalary(txId)
      await invoices.signInvoice(
        sessionOf({ id: JUNIOR_ID, role: 'JUNIOR', displayName: 'Junior' }),
        txId,
        fakeReq('203.0.113.40'),
      )

      // Simulate a LEGACY row — signed before the snapshot mechanism
      // existed (or before MED-3's same-INSERT write) — by forcing the
      // just-written snapshot back to NULL directly at the DB layer. This
      // is the ONLY way to produce that state today: MED-3 makes it
      // structurally impossible via the service layer going forward.
      await db
        .update(invoiceSignatures)
        .set({ amountSnapshot: null, currencySnapshot: null })
        .where(
          and(
            eq(invoiceSignatures.transactionId, txId),
            eq(invoiceSignatures.signerRole, 'COUNTERPARTY'),
          ),
        )

      // Before the backfill: verify falls back to the live amount — still
      // HONEST at this exact instant, because nothing has diverged yet
      // (this is the pre-migration invariant the fallback's own comment,
      // and the backfill's safety argument, both rely on).
      const beforeBackfill = await invoices.verifyInvoice(txId)
      expect(beforeBackfill.amount).toBe('1000.000000')

      // Execute the REAL migration file end-to-end (idempotent DDL +
      // backfill) against this real Postgres connection.
      const migrationSql = readFileSync(
        join(
          import.meta.dirname,
          '../../drizzle/manual/2026-08-22_invoice_signature_void_and_snapshot.sql',
        ),
        'utf-8',
      )
      await pool.query(migrationSql)

      const [backfilled] = await db
        .select()
        .from(invoiceSignatures)
        .where(
          and(
            eq(invoiceSignatures.transactionId, txId),
            eq(invoiceSignatures.signerRole, 'COUNTERPARTY'),
          ),
        )
      expect(backfilled!.amountSnapshot).toBe('1000.000000')
      expect(backfilled!.currencySnapshot).toBe('USD')

      // THE actual HIGH-1 scenario: a live amount edit lands on the
      // transaction AFTER the backfill ran. The backstop must now hold for
      // this legacy-but-backfilled row exactly as it does for a
      // freshly-signed one — this is what was impossible before the fix
      // (the fallback would have leaked '9999' here).
      await db.update(transactions).set({ amount: '9999' }).where(eq(transactions.id, txId))

      const afterBackfill = await invoices.verifyInvoice(txId)
      expect(afterBackfill.amount).toBe('1000.000000')
      expect(afterBackfill.amount).not.toBe('9999.000000')
    }, 30_000)

    /**
     * HIGH-2 (security-review round 3, PR #600). The HIGH-1 test above only
     * exercises SALARY, where the backfill source (`tx.amount`) and the
     * signed source (also `tx.amount`, via `InvoicesService.signInvoice`'s
     * non-PAYOUT branch) are the SAME column by construction — that test
     * could not have caught a backfill that reads the wrong source, because
     * for SALARY there IS no wrong source to pick. PAYOUT is the one type
     * where they diverge: `signInvoice`'s BIZ-05 branch snapshots the
     * AGGREGATED linked-income sum, never the live `tx.amount` (the USDT
     * payable — a different number, in a different currency, by
     * construction). This proves, against the ACTUAL shipped migration
     * file: (a) a PAYOUT COUNTERPARTY row is left NULL rather than
     * backfilled with the wrong number, and (b) the migration's own
     * fail-loud verify block does not RAISE EXCEPTION on that intentional
     * gap (it would abort Step 2af of `.github/workflows/deploy.yml` on
     * prod if it did).
     */
    it('HIGH-2: the migration file does NOT backfill a legacy PAYOUT COUNTERPARTY row from tx.amount (structurally the wrong number/currency) — and its verify block does not RAISE EXCEPTION on that gap', async () => {
      const payoutRequestId = randomUUID()
      // incomeAmount (1000 USD, what was actually signed via the aggregated
      // linked-income sum) deliberately differs from payableAmount (740
      // USDT, what `transactions.amount` holds on the PAYOUT row) — mirrors
      // the real BIZ-05 divergence: payable = income * (1 - share%), plus a
      // currency change (USD -> USDT).
      await db.insert(payoutRequests).values({
        id: payoutRequestId,
        seniorId: SENIOR_ID,
        incomeAmount: '1000',
        payableAmount: '740',
        contractAddress: `0x${'1'.repeat(40)}`,
        status: 'PAID',
      })

      const incomeTxId = randomUUID()
      await db.insert(transactions).values({
        id: incomeTxId,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '1000',
        currency: 'USD',
        receiverId: SENIOR_ID,
        payoutRequestId,
        createdBy: ADMIN_ID,
      })

      const payoutTxId = randomUUID()
      await db.insert(transactions).values({
        id: payoutTxId,
        type: 'PAYOUT',
        status: 'PAID',
        // BIZ-05: the USDT payable — intentionally NOT the 1000 signed above.
        amount: '740',
        currency: 'USDT',
        senderId: SENIOR_ID,
        payoutRequestId,
        createdBy: ADMIN_ID,
      })

      await invoices.autoCreateForPayout(payoutTxId)
      await invoices.signInvoice(
        sessionOf({ id: SENIOR_ID, role: 'SENIOR', displayName: 'Senior' }),
        payoutTxId,
        fakeReq('203.0.113.60'),
      )

      // Confirm signInvoice actually wrote the AGGREGATED income amount
      // (1000), never the live tx.amount (740) — the BIZ-05 invariant HIGH-2
      // depends on. If this ever fails, the rest of this test is moot.
      const [signedRow] = await db
        .select()
        .from(invoiceSignatures)
        .where(
          and(
            eq(invoiceSignatures.transactionId, payoutTxId),
            eq(invoiceSignatures.signerRole, 'COUNTERPARTY'),
          ),
        )
      expect(signedRow!.amountSnapshot).toBe('1000.000000')
      expect(signedRow!.currencySnapshot).toBe('USD')

      // Simulate a LEGACY PAYOUT row — signed before this migration (or
      // MED-3's same-INSERT write) existed — same technique as the HIGH-1
      // test above.
      await db
        .update(invoiceSignatures)
        .set({ amountSnapshot: null, currencySnapshot: null })
        .where(
          and(
            eq(invoiceSignatures.transactionId, payoutTxId),
            eq(invoiceSignatures.signerRole, 'COUNTERPARTY'),
          ),
        )

      // Execute the REAL migration file end-to-end. Must NOT throw — a
      // verify block that still counted PAYOUT rows would RAISE EXCEPTION
      // here, exactly as it would on prod (Step 2af).
      // LOW-2 (security-review round 4, PR #600): `.resolves.not.toThrow()`
      // on a non-function short-circuits to "the promise settled" — it does
      // not actually assert anything useful beyond that. A plain `await`
      // makes an unexpected rejection fail this test loudly instead.
      const migrationSql = readFileSync(
        join(
          import.meta.dirname,
          '../../drizzle/manual/2026-08-22_invoice_signature_void_and_snapshot.sql',
        ),
        'utf-8',
      )
      await pool.query(migrationSql)

      // Core HIGH-2 assertion: the backfill must NOT have touched this row.
      // Backfilling it would have written '740.000000'/'USDT' (the wrong,
      // never-signed number) and made that indistinguishable from a real
      // signature forever.
      const [afterMigration] = await db
        .select()
        .from(invoiceSignatures)
        .where(
          and(
            eq(invoiceSignatures.transactionId, payoutTxId),
            eq(invoiceSignatures.signerRole, 'COUNTERPARTY'),
          ),
        )
      expect(afterMigration!.amountSnapshot).toBeNull()
      expect(afterMigration!.currencySnapshot).toBeNull()

      // HIGH-3 (security-review round 4, PR #600): this is the core
      // assertion this whole test exists to make now. Round 3 left this
      // exact scenario asserting the OLD, WRONG behavior right here (see
      // git blame) — "verifyInvoice must still return exactly what it
      // always returned for this row (no user-visible regression) — the
      // live tx.amount fallback" — and that comment was the false
      // obligation HIGH-3 identified: it locked in an external-facing
      // discrepancy (signed 1000.000000 USD, verify answered
      // 740.000000 USDT — a synced-in-time, not merely internally
      // consistent, contradiction on the SAME printed document) as if it
      // were a requirement. verifyInvoice must now recompute the aggregate
      // from the still-live linked-income rows (the same
      // 1000/USD `signInvoice` actually signed above), not fall back to
      // the PAYOUT row's own `tx.amount` (740/USDT, the unrelated USDT
      // payable — BIZ-05).
      const verify = await invoices.verifyInvoice(payoutTxId)
      expect(verify.amount).toBe('1000.000000')
      expect(verify.currency).toBe('USD')
    }, 30_000)

    /**
     * HIGH-3 edge case, AC2-bis (round 4, security-review, PR #600):
     * `resolvePayoutAggregateAmount`'s own doc comment names three cases it
     * refuses to resolve rather than guess at — this is the "linked incomes
     * span more than one currency" one. The PRE-round-4 inline version of
     * this logic summed `parseFloat` amounts across whatever currency the
     * FIRST row happened to carry (no `ORDER BY`, i.e. non-deterministically)
     * and never validated the rows agreed on a currency at all — silently
     * adding USD to EUR and calling the result a number. This proves the
     * refusal is real: `verifyInvoice` throws instead of returning a
     * fabricated sum, for a NULL-snapshot PAYOUT row whose linked incomes
     * have drifted into more than one currency SINCE it was signed (the
     * exact "reconstruction from possibly-since-edited live rows" risk the
     * HIGH-3 fix comment gives as the reason a backfill was rejected).
     */
    it('AC2-bis: verifyInvoice refuses to confirm an amount for a NULL-snapshot PAYOUT row whose linked incomes now span more than one currency, instead of silently summing across currencies', async () => {
      const payoutRequestId = randomUUID()
      await db.insert(payoutRequests).values({
        id: payoutRequestId,
        seniorId: SENIOR_ID,
        incomeAmount: '1000',
        payableAmount: '740',
        contractAddress: `0x${'2'.repeat(40)}`,
        status: 'PAID',
      })

      const incomeTxId = randomUUID()
      await db.insert(transactions).values({
        id: incomeTxId,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '1000',
        currency: 'USD',
        receiverId: SENIOR_ID,
        payoutRequestId,
        createdBy: ADMIN_ID,
      })

      const payoutTxId = randomUUID()
      await db.insert(transactions).values({
        id: payoutTxId,
        type: 'PAYOUT',
        status: 'PAID',
        amount: '740',
        currency: 'USDT',
        senderId: SENIOR_ID,
        payoutRequestId,
        createdBy: ADMIN_ID,
      })

      // Sign honestly FIRST, while there is exactly one linked-income
      // currency — this is the only way to reach a real COUNTERPARTY row at
      // all (signInvoice's own fallback for an UNRESOLVABLE aggregate is
      // tx.amount, not a thrown error — see the comment on
      // `payoutAggregatedAmount` in signInvoice). The currency drift below
      // happens AFTER signing, mirroring how a real legacy row would age.
      await invoices.autoCreateForPayout(payoutTxId)
      await invoices.signInvoice(
        sessionOf({ id: SENIOR_ID, role: 'SENIOR', displayName: 'Senior' }),
        payoutTxId,
        fakeReq('203.0.113.61'),
      )

      // Simulate a LEGACY row (same technique as HIGH-1/HIGH-2 above).
      await db
        .update(invoiceSignatures)
        .set({ amountSnapshot: null, currencySnapshot: null })
        .where(
          and(
            eq(invoiceSignatures.transactionId, payoutTxId),
            eq(invoiceSignatures.signerRole, 'COUNTERPARTY'),
          ),
        )

      // Currency drift: a SECOND linked income for the SAME payoutRequestId
      // shows up in a DIFFERENT currency. `resolvePayoutAggregateAmount`'s
      // query has no currency filter (by design — a payout can legitimately
      // aggregate several income rows), so this is exactly what the
      // mixed-currency guard exists to catch.
      const secondIncomeTxId = randomUUID()
      await db.insert(transactions).values({
        id: secondIncomeTxId,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '500',
        currency: 'EUR',
        receiverId: SENIOR_ID,
        payoutRequestId,
        createdBy: ADMIN_ID,
      })

      await expect(invoices.verifyInvoice(payoutTxId)).rejects.toThrow(ConflictException)
      await expect(invoices.verifyInvoice(payoutTxId)).rejects.toThrow(
        'Не удалось подтвердить сумму этого инвойса',
      )

      // Cleanup — this row is NOT covered by afterAll's createdBy filter for
      // `payoutTxId`/`incomeTxId` (both created here), but IS its own row
      // with the same createdBy, so it is in fact covered. Left explicit
      // for a future reader who moves this fixture out of `createdBy:
      // ADMIN_ID` scope.
    }, 30_000)

    /**
     * HIGH-3 edge case, AC2-bis (round 4, security-review, PR #600): the
     * "zero linked incomes" case — `resolvePayoutAggregateAmount` returns
     * `null` immediately (`linkedIncomes.length === 0`), same as the
     * mixed-currency case above, and for the same reason: nothing here to
     * honestly reconstruct. Modelled as the income row being soft-deleted
     * AFTER the PAYOUT invoice was signed (a correction reversing the
     * income), which is exactly how `nonDeletedTransactions` stops counting
     * a row without physically removing history.
     */
    it('AC2-bis: verifyInvoice refuses to confirm an amount for a NULL-snapshot PAYOUT row with zero (still-live) linked incomes, instead of falling back to the unrelated tx.amount', async () => {
      const payoutRequestId = randomUUID()
      await db.insert(payoutRequests).values({
        id: payoutRequestId,
        seniorId: SENIOR_ID,
        incomeAmount: '1000',
        payableAmount: '740',
        contractAddress: `0x${'3'.repeat(40)}`,
        status: 'PAID',
      })

      const incomeTxId = randomUUID()
      await db.insert(transactions).values({
        id: incomeTxId,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '1000',
        currency: 'USD',
        receiverId: SENIOR_ID,
        payoutRequestId,
        createdBy: ADMIN_ID,
      })

      const payoutTxId = randomUUID()
      await db.insert(transactions).values({
        id: payoutTxId,
        type: 'PAYOUT',
        status: 'PAID',
        amount: '740',
        currency: 'USDT',
        senderId: SENIOR_ID,
        payoutRequestId,
        createdBy: ADMIN_ID,
      })

      await invoices.autoCreateForPayout(payoutTxId)
      await invoices.signInvoice(
        sessionOf({ id: SENIOR_ID, role: 'SENIOR', displayName: 'Senior' }),
        payoutTxId,
        fakeReq('203.0.113.62'),
      )
      await db
        .update(invoiceSignatures)
        .set({ amountSnapshot: null, currencySnapshot: null })
        .where(
          and(
            eq(invoiceSignatures.transactionId, payoutTxId),
            eq(invoiceSignatures.signerRole, 'COUNTERPARTY'),
          ),
        )

      // The linked income vanishes from `nonDeletedTransactions` AFTER
      // signing — a correction reversing it, discovered after the
      // counterparty already signed.
      await db
        .update(transactions)
        .set({ deletedAt: new Date() })
        .where(eq(transactions.id, incomeTxId))

      await expect(invoices.verifyInvoice(payoutTxId)).rejects.toThrow(ConflictException)
      await expect(invoices.verifyInvoice(payoutTxId)).rejects.toThrow(
        'Не удалось подтвердить сумму этого инвойса',
      )

      // Undo the soft-delete so afterAll's plain `transactions` delete
      // (not `nonDeletedTransactions`-scoped) still finds and removes this
      // fixture row like every other one in this suite.
      await db.update(transactions).set({ deletedAt: null }).where(eq(transactions.id, incomeTxId))
    }, 30_000)

    /**
     * MED-1 (security-review round 2, PR #600). `signInvoice` and
     * `voidInvoiceForAmountEdit` take no shared lock across the S3
     * render/upload `signInvoice` does — a concurrent void→reissue landing
     * in that window used to let `signInvoice`'s COUNTERPARTY insert (and,
     * before the fix, its unconditional final repoint) survive against a
     * document that had already been superseded. Simulated here via
     * `FakeS3Service.onGetObject` — the ONLY await point in `signInvoice`
     * between it reading the COMPANY signature/document and inserting its
     * own COUNTERPARTY row — no real threads needed, single-threaded
     * async interleaving is enough to reproduce the race deterministically.
     */
    it('MED-1: a void->reissue racing signInvoice mid-flight makes it throw 409 instead of corrupting invoiceDocumentId or leaving an orphaned active signature', async () => {
      const txId = randomUUID()
      await db.insert(transactions).values({
        id: txId,
        type: 'SALARY',
        status: 'PAID',
        amount: '500',
        currency: 'USD',
        receiverId: JUNIOR_ID,
        createdBy: ADMIN_ID,
      })

      await invoices.autoCreateForSalary(txId)
      const [beforeRace] = await db.select().from(transactions).where(eq(transactions.id, txId))
      const originalDocId = beforeRace!.invoiceDocumentId
      expect(originalDocId).not.toBeNull()

      // Inject the race exactly where signInvoice downloads the CURRENT
      // PDF to verify its hash.
      fakeS3.onGetObject = async () => {
        await invoices.voidAndReissueInvoiceForAmountEdit(txId, ADMIN_ID)
      }

      await expect(
        invoices.signInvoice(
          sessionOf({ id: JUNIOR_ID, role: 'JUNIOR', displayName: 'Junior' }),
          txId,
          fakeReq('203.0.113.50'),
        ),
      ).rejects.toThrow(ConflictException)

      // The reissue's FRESH invoiceDocumentId must survive completely
      // untouched — the losing signInvoice call must not have repointed
      // onto its own stale render (the original corruption HIGH's fix
      // targets).
      const [afterRace] = await db.select().from(transactions).where(eq(transactions.id, txId))
      expect(afterRace!.invoiceDocumentId).not.toBeNull()
      expect(afterRace!.invoiceDocumentId).not.toBe(originalDocId)

      // The losing call's COUNTERPARTY row must never have been inserted at
      // all — the insert-side FOR UPDATE guard refuses BEFORE writing, so
      // no orphaned "active" signature (attesting to the superseded
      // document's bytes) is left behind for the fresh reissue to
      // incorrectly inherit as "SIGNED".
      const sigsAfterRace = await db
        .select()
        .from(invoiceSignatures)
        .where(eq(invoiceSignatures.transactionId, txId))
      const activeCounterparty = sigsAfterRace.filter(
        (s) => s.signerRole === 'COUNTERPARTY' && s.voidedAt === null,
      )
      expect(activeCounterparty.length).toBe(0)

      // The fresh reissue is honestly PENDING — nobody has signed it.
      const freshInvoice = await invoices.getInvoice(
        sessionOf({ id: ADMIN_ID, role: 'ADMIN', displayName: 'Admin' }),
        txId,
      )
      expect(freshInvoice.status).toBe('PENDING')
    }, 30_000)

    /**
     * MED-B (security-review round 3, PR #600). The MED-1 test above proves
     * the OUTCOME (409, no corruption) but does NOT contest the
     * `SELECT ... FOR UPDATE` lock itself: `fakeS3.onGetObject` `await`s
     * `voidAndReissueInvoiceForAmountEdit` to FULL COMPLETION (including its
     * commit) before `signInvoice`'s own transaction ever opens — the void
     * has already released any lock by the time signInvoice's `FOR UPDATE`
     * select runs, so that select never actually waits on anything. The 409
     * there comes entirely from the plain `invoiceDocumentId !== doc.id`
     * comparison; a mutant that deleted `.for('update')` from signInvoice's
     * select would still pass that test unchanged (mutation-tally's
     * `NoCoverage` count says nothing about it either — see
     * `.claude/rules/common/mutation-gate-integration-specs.md`: `NoCoverage`
     * is silent on mutants that are never contested, only on mutants the
     * gate cannot SEE at all).
     *
     * This test genuinely contests the lock: `documentsService
     * .softDeleteInternal` — the first call INSIDE `voidInvoiceForAmountEdit`'s
     * transaction after it acquires `FOR UPDATE`, still on the same open
     * `dbtx` — is intercepted to pause on a promise this test controls. While
     * paused, void's transaction is genuinely open with the row lock held.
     * `signInvoice` is started concurrently, racing to acquire its OWN
     * `FOR UPDATE` on the same row.
     *
     * PROOF MECHANISM (deterministic, not a timing heuristic): a first
     * version of this test asserted "signInvoice has not settled after a
     * fixed 200ms delay" — that turned out to be a FALSE POSITIVE. Verified
     * by hand: with `.for('update')` removed from signInvoice's select, the
     * test still passed, because signInvoice's own PDF-generation +
     * multiple preceding DB round-trips happened to still be in flight past
     * the 200ms mark for reasons that have nothing to do with locking, and
     * by the time its (now-unguarded) SELECT actually ran, this test had
     * already released the void anyway — so it read the post-void state by
     * SCHEDULING LUCK, not by waiting on Postgres. A fixed delay cannot
     * distinguish "blocked by the lock" from "just slow for unrelated
     * reasons". Instead, this test polls `pg_stat_activity` for a backend
     * that is ACTUALLY `wait_event_type = 'Lock'` on a query touching
     * `transactions ... for update` — the ONLY way that state can exist is
     * a second session's `FOR UPDATE` genuinely contending for a row
     * another open transaction already holds. If `.for('update')` is ever
     * removed from signInvoice's select, no such row can ever appear (a
     * plain `SELECT` never blocks on another transaction's row lock under
     * READ COMMITTED) and the wait below times out — a hard, unambiguous
     * failure, not a flaky race. (Confirmed both ways by hand: with the
     * lock removed, this polling wait times out as expected; restored, it
     * detects the blocked backend well within the timeout.)
     */
    it('MED-B: signInvoice truly BLOCKS on Postgres row-level locking while a void is still in flight (not just after it has already committed)', async () => {
      const txId = randomUUID()
      await db.insert(transactions).values({
        id: txId,
        type: 'SALARY',
        status: 'PAID',
        amount: '600',
        currency: 'USD',
        receiverId: JUNIOR_ID,
        createdBy: ADMIN_ID,
      })
      await invoices.autoCreateForSalary(txId)

      let releaseVoid: () => void = () => {}
      const voidPaused = new Promise<void>((resolve) => {
        releaseVoid = resolve
      })
      const originalSoftDelete = documentsService.softDeleteInternal.bind(documentsService)
      const softDeleteSpy = vi
        .spyOn(documentsService, 'softDeleteInternal')
        .mockImplementation(async (docId, deletedById, tx) => {
          await voidPaused
          return originalSoftDelete(docId, deletedById, tx)
        })

      // Fire the void — its transaction acquires FOR UPDATE, runs the
      // activeSigs select (same dbtx, lock still held), then blocks on the
      // patched softDeleteInternal above. No `await` here on purpose: the
      // whole point is to race it against signInvoice below.
      const voidPromise = invoices.voidInvoiceForAmountEdit(txId, ADMIN_ID)

      const signPromise = invoices.signInvoice(
        sessionOf({ id: JUNIOR_ID, role: 'JUNIOR', displayName: 'Junior' }),
        txId,
        fakeReq('203.0.113.70'),
      )
      // Swallow a rejection observed before the `expect().rejects` below
      // attaches its own handler — otherwise Node logs an
      // unhandledRejection warning for the (expected, awaited-later) 409.
      signPromise.catch(() => {})

      // try/finally: if the assertion below ever fails (this test itself
      // regresses, or is run against a build where the lock genuinely is
      // gone), `releaseVoid()` MUST still run — otherwise void's
      // transaction stays open forever holding the row lock, and every
      // later `DELETE FROM transactions ...` in `afterAll` hangs on it
      // (observed by hand: a first version of this test without the
      // finally left `afterAll` timing out at 30s after an assertion
      // failure here, for exactly this reason).
      try {
        // Deterministic proof: poll until a SECOND backend (not this
        // test's own connection, not void's) is genuinely parked waiting
        // on a lock for a query that touches `transactions ... for
        // update`. Fails the assertion below if that state is never
        // observed within the budget — see the doc comment above for why
        // this replaces a fixed delay.
        const deadline = Date.now() + 10_000
        let observedBlockedWaiter = false
        while (Date.now() < deadline) {
          const { rows } = await pool.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
               WHERE datname = current_database()
                 AND wait_event_type = 'Lock'
                 AND query ILIKE '%transactions%'
                 AND query ILIKE '%for update%'`,
          )
          if (rows.length > 0) {
            observedBlockedWaiter = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        expect(observedBlockedWaiter).toBe(true)

        // Release the void — its transaction commits (invoiceDocumentId
        // nulled), freeing the row lock that signInvoice was just proven
        // to be genuinely waiting on.
        releaseVoid()
        await voidPromise

        // NOW signInvoice's own FOR UPDATE select proceeds, observes the
        // post-void state, and correctly refuses — the SAME assertion
        // MED-1 makes, but this time reached through PROVEN genuine lock
        // contention rather than a pre-committed void or scheduling luck.
        await expect(signPromise).rejects.toThrow(ConflictException)
      } finally {
        releaseVoid()
        await voidPromise.catch(() => {})
        await signPromise.catch(() => {})
        softDeleteSpy.mockRestore()
      }
    }, 30_000)
  },
)
