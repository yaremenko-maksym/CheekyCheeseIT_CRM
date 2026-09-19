/**
 * `POST /api/invoices/:transactionId/sign` under impersonation — task-680
 * fix-round 3, SR-M-4.
 *
 * Real `InvoicesController`, behind the real `JwtAuthGuard` chain, against
 * real Postgres — same rationale as `invoice-signature-integrity.integration
 * .spec.ts` (a mocked harness cannot prove a global guard is even wired) and
 * `tos-accept-impersonation.integration.spec.ts` (the sibling spec for
 * SR-M-3). `invoices.controller.spec.ts` / `invoices.service.spec.ts`
 * already cover the wiring and the guard logic in isolation; this file is
 * the one place that proves the impersonation guard survives a REAL,
 * fully-issued, signable invoice — not just an empty harness — end to end
 * through HTTP.
 *
 * The signable-invoice fixture (`autoCreateForSalary` + `FakeS3Service` +
 * real `DocumentsService`/`InvoicePdfService`) is copied from
 * `invoice-signature-integrity.integration.spec.ts` rather than invented
 * fresh — same store-backed fake, same construction order.
 */
import { randomUUID } from 'node:crypto'
import { Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'
import { INVOICE_SIGN_IMPERSONATION_MESSAGE, type SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import { documents, invoiceSignatures, transactions, users } from '../database/schema'
import type { CompressionService } from '../documents/compression.service'
import { DocumentsService } from '../documents/documents.service'
import type { S3Service } from '../documents/s3.service'
import type { HrAccessService } from '../common/hr-access.service'
import { PdfGenerationService } from '../common/pdf/pdf-generation.service'
import { NotificationsService } from '../notifications/notifications.service'
import { makeTelemetryErrorsStub } from '../telemetry/__test-helpers__/telemetry-errors-stub'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import { ZodExceptionFilter } from '../zod-exception.filter'
import { InvoicesController } from './invoices.controller'
import { InvoicePdfService } from './invoice-pdf.service'
import { InvoicesService } from './invoices.service'

/** In-memory S3 fake — copied from invoice-signature-integrity.integration.spec.ts. */
class FakeS3Service {
  private store = new Map<string, Buffer>()
  upload(key: string, body: Buffer): Promise<void> {
    this.store.set(key, body)
    return Promise.resolve()
  }
  async getObject(key: string): Promise<Buffer> {
    const buf = this.store.get(key)
    if (!buf) return Promise.reject(new Error(`FakeS3Service: no object at ${key}`))
    return buf
  }
  delete(key: string): Promise<void> {
    this.store.delete(key)
    return Promise.resolve()
  }
}

const JWT_SECRET = 'invoice-sign-impersonation-secret-32-chars'
const TAG = 'invsign-imperson'

const ADMIN_ID = randomUUID()
const JUNIOR_ID = randomUUID() // SALARY counterparty

const ROLE_ROWS = new Map<string, { role: SessionUser['role']; archivedAt: Date | null }>([
  [ADMIN_ID, { role: 'ADMIN', archivedAt: null }],
  [JUNIOR_ID, { role: 'JUNIOR', archivedAt: null }],
])
const usersServiceStub = { findById: (id: string) => Promise.resolve(ROLE_ROWS.get(id)) }

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
  controllers: [InvoicesController],
  providers: [
    // Wired by hand after `app.init()` (esbuild/vite DI gap) — placeholder
    // keeps Nest's constructor resolution happy in the meantime.
    { provide: InvoicesService, useValue: {} },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) =>
        new JwtAuthGuard(jwtSvc, reflector, usersServiceStub as never),
      inject: [JwtService, Reflector],
    },
  ],
})
class InvoiceSignImpersonationTestModule {}

describe.skipIf(!hasDatabaseUrl())(
  'POST /invoices/:transactionId/sign под имперсонацией (SR-M-4)',
  () => {
    let app: NestFastifyApplication
    let jwt: JwtService
    let pool: Pool
    let db: ReturnType<typeof drizzle<typeof schema>>
    let txId: string

    beforeAll(async () => {
      await assertRealDbSchema([{ table: 'invoice_signatures', column: 'pdf_hash' }])

      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      db = drizzle(pool, { schema })
      const dbService = { db } as unknown as DatabaseService

      await db
        .insert(users)
        .values([
          { id: ADMIN_ID, email: `${TAG}-admin@x.test`, displayName: 'Admin', role: 'ADMIN' },
          { id: JUNIOR_ID, email: `${TAG}-junior@x.test`, displayName: 'Junior', role: 'JUNIOR' },
        ])
        .onConflictDoNothing()

      const pdfGen = new PdfGenerationService()
      const invoicePdf = new InvoicePdfService(pdfGen)
      const fakeS3 = new FakeS3Service()
      const documentsService = new DocumentsService(
        dbService,
        fakeS3 as unknown as S3Service,
        {} as unknown as CompressionService,
        {} as unknown as HrAccessService,
      )
      const notifications = new NotificationsService(dbService, makeTelemetryErrorsStub())
      const fakeConfig = { get: () => 'https://verify.test' } as unknown as ConfigService<Env, true>
      const invoicesService = new InvoicesService(
        dbService,
        invoicePdf,
        documentsService,
        fakeS3 as unknown as S3Service,
        notifications,
        fakeConfig,
      )

      // A genuinely signable SALARY invoice — COMPANY auto-signs, counterparty
      // has not signed yet. If the impersonation guard were absent, the
      // impersonated request below WOULD succeed and write a real
      // COUNTERPARTY row here.
      txId = randomUUID()
      await db.insert(transactions).values({
        id: txId,
        type: 'SALARY',
        status: 'PAID',
        amount: '1000',
        currency: 'USD',
        receiverId: JUNIOR_ID,
        createdBy: ADMIN_ID,
      })
      await invoicesService.autoCreateForSalary(txId)

      const moduleRef = await Test.createTestingModule({
        imports: [InvoiceSignImpersonationTestModule],
      }).compile()
      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'invoice-sign-impersonation-cookie-secret' })
      app.setGlobalPrefix('api')
      app.useGlobalFilters(new ZodExceptionFilter())
      await app.init()
      await app.getHttpAdapter().getInstance().ready()
      jwt = moduleRef.get(JwtService)

      Object.assign(app.get(InvoicesController), { svc: invoicesService })
    }, 60_000)

    afterAll(async () => {
      await db.delete(invoiceSignatures).where(eq(invoiceSignatures.transactionId, txId))
      await db.delete(documents).where(inArray(documents.ownerId, [JUNIOR_ID]))
      await db.delete(transactions).where(eq(transactions.id, txId))
      await db.delete(users).where(inArray(users.id, [ADMIN_ID, JUNIOR_ID]))
      await app.close()
      await pool.end()
    }, 30_000)

    const tokenForImpersonated = (impersonatorId: string) =>
      jwt.sign({ id: JUNIOR_ID, email: `${TAG}-junior@x.test`, role: 'JUNIOR', impersonatorId })

    it('под имперсонацией — 403 с общим литералом, подпись COUNTERPARTY не записана', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/invoices/${txId}/sign`,
        cookies: { jwt: tokenForImpersonated(ADMIN_ID) },
        payload: {},
      })

      expect(res.statusCode).toBe(403)
      const body = res.json<{ message: string }>()
      expect(body.message).toBe(INVOICE_SIGN_IMPERSONATION_MESSAGE)

      const rows = await db
        .select()
        .from(invoiceSignatures)
        .where(eq(invoiceSignatures.transactionId, txId))
      expect(rows.filter((r) => r.signerRole === 'COUNTERPARTY')).toHaveLength(0)
    })

    it('без имперсонации тот же запрос — 200, подпись COUNTERPARTY записана', async () => {
      const token = jwt.sign({ id: JUNIOR_ID, email: `${TAG}-junior@x.test`, role: 'JUNIOR' })
      const res = await app.inject({
        method: 'POST',
        url: `/api/invoices/${txId}/sign`,
        cookies: { jwt: token },
        payload: {},
      })

      expect(res.statusCode).toBe(201)

      const rows = await db
        .select()
        .from(invoiceSignatures)
        .where(eq(invoiceSignatures.transactionId, txId))
      expect(rows.filter((r) => r.signerRole === 'COUNTERPARTY')).toHaveLength(1)
    })
  },
)
