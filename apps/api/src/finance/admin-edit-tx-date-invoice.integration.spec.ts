import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ConfigService } from '@nestjs/config'
import type { SessionUser } from '@crm/shared'
import type { Env } from '../config/env'
import type { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import {
  documents,
  invoiceSignatures,
  notifications,
  transactionAuditLog,
  transactions,
  users,
} from '../database/schema'
import { InvoicesService } from '../invoices/invoices.service'
import { InvoicePdfService } from '../invoices/invoice-pdf.service'
import { PdfGenerationService } from '../common/pdf/pdf-generation.service'
import { DocumentsService } from '../documents/documents.service'
import type { S3Service } from '../documents/s3.service'
import type { CompressionService } from '../documents/compression.service'
import type { HrAccessService } from '../common/hr-access.service'
import { NotificationsService } from '../notifications/notifications.service'
import { makeTelemetryErrorsStub } from '../telemetry/__test-helpers__/telemetry-errors-stub'
import { hasDatabaseUrl } from '../test/require-real-db'
import type { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

/**
 * SPEC-L-2 (PR #1213 follow-up) — a business-date change on a row with a live
 * invoice, against real Postgres and the REAL InvoicesService (no invoices spy):
 * the old document is voided and a new one issued; and when the re-issue
 * fails, the edit still commits, `INVOICE_REISSUE_FAILED` is journalled and the
 * response carries `invoiceReissueIncomplete`.
 *
 * Only S3 is faked (in memory), with a switch that makes uploads fail.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@127.0.0.1:5432/crm_scratch_<name> \
 *     pnpm --filter @crm/api exec vitest run src/finance/admin-edit-tx-date-invoice.integration.spec.ts
 */

class FakeS3Service {
  private store = new Map<string, Buffer>()
  failUploads = false
  upload(key: string, body: Buffer): Promise<void> {
    if (this.failUploads) return Promise.reject(new Error('FakeS3Service: upload refused'))
    this.store.set(key, body)
    return Promise.resolve()
  }
  getObject(key: string): Promise<Buffer> {
    const buf = this.store.get(key)
    return buf ? Promise.resolve(buf) : Promise.reject(new Error(`FakeS3Service: no ${key}`))
  }
  delete(key: string): Promise<void> {
    this.store.delete(key)
    return Promise.resolve()
  }
}

const ADMIN_ID = randomUUID()
const JUNIOR_ID = randomUUID()
const ADMIN: SessionUser = {
  id: ADMIN_ID,
  email: `txd-inv-admin-${ADMIN_ID}@x.test`,
  displayName: 'TXD Invoice Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

function dayAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}
const STORED_DAY = dayAgo(10)
const NEW_DAY = dayAgo(20)

describe.skipIf(!hasDatabaseUrl())(
  'admin date edit re-issues a live invoice (real DB, real InvoicesService) — SPEC-L-2',
  () => {
    let pool: Pool
    let db: ReturnType<typeof drizzle<typeof schema>>
    let fakeS3: FakeS3Service
    let svc: TransactionsService
    let invoices: InvoicesService

    beforeAll(async () => {
      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const which = await pool.query('SELECT current_database() AS db')
      if (which.rows[0]?.db === 'crm_db') {
        throw new Error('[admin-edit-tx-date-invoice] REFUSING to run against the live crm_db')
      }
      db = drizzle(pool, { schema })
      await db.insert(users).values([
        { id: ADMIN_ID, email: ADMIN.email, displayName: ADMIN.displayName, role: 'ADMIN' },
        {
          id: JUNIOR_ID,
          email: `txd-inv-junior-${JUNIOR_ID}@x.test`,
          displayName: 'TXD Invoice Junior',
          role: 'JUNIOR',
        },
      ])

      const dbService = { db } as unknown as DatabaseService
      fakeS3 = new FakeS3Service()
      const documentsService = new DocumentsService(
        dbService,
        fakeS3 as unknown as S3Service,
        {} as unknown as CompressionService,
        {} as unknown as HrAccessService,
      )
      invoices = new InvoicesService(
        dbService,
        new InvoicePdfService(new PdfGenerationService()),
        documentsService,
        fakeS3 as unknown as S3Service,
        new NotificationsService(dbService, makeTelemetryErrorsStub()),
        { get: () => 'https://verify.test' } as unknown as ConfigService<Env, true>,
      )
      svc = makeTransactionsService({ db: dbService, invoicesService: invoices })
    }, 60_000)

    beforeEach(() => {
      fakeS3.failUploads = false
    })

    afterAll(async () => {
      const ids = (
        await db
          .select({ id: transactions.id })
          .from(transactions)
          .where(eq(transactions.createdBy, ADMIN_ID))
      ).map((r) => r.id)
      if (ids.length > 0) {
        await db.delete(invoiceSignatures).where(inArray(invoiceSignatures.transactionId, ids))
        await db.delete(transactionAuditLog).where(inArray(transactionAuditLog.targetId, ids))
        await db.delete(transactions).where(inArray(transactions.id, ids))
      }
      await db.delete(documents).where(inArray(documents.ownerId, [ADMIN_ID, JUNIOR_ID]))
      await db.delete(notifications).where(inArray(notifications.userId, [ADMIN_ID, JUNIOR_ID]))
      await db.delete(users).where(inArray(users.id, [ADMIN_ID, JUNIOR_ID]))
      await pool.end()
    }, 30_000)

    /** A PAID salary with a live, COMPANY-signed invoice built by the real service. */
    async function seedSalaryWithInvoice(): Promise<{ id: string; doc: string }> {
      const id = randomUUID()
      await db.insert(transactions).values({
        id,
        type: 'SALARY',
        status: 'PAID',
        amount: '1000',
        currency: 'USD',
        receiverId: JUNIOR_ID,
        createdBy: ADMIN_ID,
        txDate: new Date(`${STORED_DAY}T12:00:00.000Z`),
      })
      await invoices.autoCreateForSalary(id)
      const doc = (await row(id)).invoiceDocumentId
      expect(doc).not.toBeNull()
      return { id, doc: doc! }
    }
    const row = async (id: string) =>
      (await db.query.transactions.findFirst({ where: eq(transactions.id, id) }))!
    const activeSignatures = (id: string) =>
      db
        .select()
        .from(invoiceSignatures)
        .where(and(eq(invoiceSignatures.transactionId, id), isNull(invoiceSignatures.voidedAt)))
    const failureJournal = (id: string) =>
      db.query.transactionAuditLog.findMany({
        where: and(
          eq(transactionAuditLog.targetId, id),
          eq(transactionAuditLog.action, 'INVOICE_REISSUE_FAILED'),
        ),
      })

    it('voids the live invoice and issues a new one; nothing is journalled as failed', async () => {
      const { id, doc } = await seedSalaryWithInvoice()
      const [oldSignature] = await activeSignatures(id)
      expect(oldSignature).toBeDefined()

      const result = await svc.adminUpdateTransaction(id, { txDate: NEW_DAY }, ADMIN)

      expect(result.invoiceReissueIncomplete).toBeUndefined()
      const after = await row(id)
      expect(after.txDate!.toISOString().slice(0, 10)).toBe(NEW_DAY)
      expect(after.invoiceDocumentId).not.toBeNull()
      expect(after.invoiceDocumentId).not.toBe(doc)
      const [voided] = await db
        .select()
        .from(invoiceSignatures)
        .where(eq(invoiceSignatures.id, oldSignature!.id))
      expect(voided!.voidedAt).not.toBeNull()
      const active = await activeSignatures(id)
      expect(active).toHaveLength(1)
      expect(active[0]!.id).not.toBe(oldSignature!.id)
      expect(await failureJournal(id)).toHaveLength(0)
    })

    it('a failed re-issue keeps the date, journals INVOICE_REISSUE_FAILED and flags the response; a re-save repairs it', async () => {
      const { id } = await seedSalaryWithInvoice()
      fakeS3.failUploads = true

      const result = await svc.adminUpdateTransaction(id, { txDate: NEW_DAY }, ADMIN)

      expect(result.invoiceReissueIncomplete).toBe('SELF_REPAIRABLE')
      const after = await row(id)
      expect(after.txDate!.toISOString().slice(0, 10)).toBe(NEW_DAY)
      expect(after.invoiceDocumentId).toBeNull()
      const failures = await failureJournal(id)
      expect(failures).toHaveLength(1)
      expect(failures[0]!.actorId).toBe(ADMIN_ID)
      expect(failures[0]!.metadata).toEqual({ stage: 'REISSUE' })

      fakeS3.failUploads = false
      const repaired = await svc.adminUpdateTransaction(id, { notes: 'save again' }, ADMIN)
      expect(repaired.invoiceReissueIncomplete).toBeUndefined()
      expect((await row(id)).invoiceDocumentId).not.toBeNull()
      expect(await failureJournal(id)).toHaveLength(1)
    })
  },
)
