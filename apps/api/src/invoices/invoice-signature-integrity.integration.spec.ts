/**
 * task-invoice-signature-integrity — integration spec (AC4).
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
import { NotFoundException } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConfigService } from '@nestjs/config'
import type { FastifyRequest } from 'fastify'
import type { SessionUser } from '@crm/shared'
import type { Env } from '../config/env'
import type { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import { documents, invoiceSignatures, transactions, users } from '../database/schema'
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
  upload(key: string, body: Buffer): Promise<void> {
    this.store.set(key, body)
    return Promise.resolve()
  }
  getObject(key: string): Promise<Buffer> {
    const buf = this.store.get(key)
    if (!buf) return Promise.reject(new Error(`FakeS3Service: no object at ${key}`))
    return Promise.resolve(buf)
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

    const ADMIN_ID = randomUUID()
    const JUNIOR_ID = randomUUID() // SALARY counterparty — the AC2-bis leaf case

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
        ])
        .onConflictDoNothing()

      const dbService = { db } as unknown as DatabaseService
      const pdfGen = new PdfGenerationService()
      const invoicePdf = new InvoicePdfService(pdfGen)
      const fakeS3 = new FakeS3Service() as unknown as S3Service
      const documentsService = new DocumentsService(
        dbService,
        fakeS3,
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
        fakeS3,
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
        await db.delete(documents).where(inArray(documents.ownerId, [JUNIOR_ID]))
        await db.delete(transactions).where(inArray(transactions.id, ids))
      }
      await db.delete(users).where(inArray(users.id, [ADMIN_ID, JUNIOR_ID]))
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
  },
)
