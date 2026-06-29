import { Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { ZodExceptionFilter } from '../zod-exception.filter'
import { DatabaseService } from '../database/database.service'
import { ContractTemplatesController } from './contract-templates.controller'
import { ContractTemplatesService } from './contract-templates.service'
import { ContractPdfService } from './contract-pdf.service'
import { PdfGenerationService } from '../common/pdf/pdf-generation.service'

/**
 * Part 3 — POST /api/contracts/templates/preview-pdf.
 *
 * Stands up the REAL ContractTemplatesController behind the REAL
 * JwtAuthGuard + RolesGuard chain (green-wash lesson: mocked guards give false
 * confidence). The DatabaseService is mocked (the only DB touch in this route is
 * `companyAccount.findFirst()` to fetch requisites — we feed a known value).
 * ContractPdfService + PdfGenerationService are REAL so a real PDF is produced.
 *
 * Asserts:
 *   - ADMIN → 200 + valid `%PDF` bytes (visible tokens + appended requisites).
 *   - every non-ADMIN role → 403.
 *   - invalid body (empty markdown) → 400 (Zod).
 *
 * No external DB required — runs anywhere.
 */

const JWT_SECRET = 'contract-preview-pdf-integration-secret-32c'
const REQUISITES = '## Реквизиты\n\nООО «Тест», IBAN UA00 0000'

const base: SessionUser = {
  id: 'cp111111-0000-4000-aa00-000000000001',
  email: 'cp-admin@test.spec',
  displayName: 'CP Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ADMIN = base
const ACCOUNTANT: SessionUser = { ...base, id: 'cp-acct', email: 'cp-acct@t', role: 'ACCOUNTANT' }
const SENIOR: SessionUser = { ...base, id: 'cp-sen', email: 'cp-sen@t', role: 'SENIOR' }
const JUNIOR: SessionUser = { ...base, id: 'cp-jun', email: 'cp-jun@t', role: 'JUNIOR' }
const HR: SessionUser = { ...base, id: 'cp-hr', email: 'cp-hr@t', role: 'HR' }
const DROP: SessionUser = { ...base, id: 'cp-drop', email: 'cp-drop@t', role: 'DROP' }

// Mocked DatabaseService — only `db.query.companyAccount.findFirst()` is used.
const dbMock = {
  db: {
    query: {
      companyAccount: {
        findFirst: vi.fn().mockResolvedValue({ requisitesMarkdown: REQUISITES }),
      },
    },
  },
} as unknown as DatabaseService

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
  controllers: [ContractTemplatesController],
  providers: [
    Reflector,
    PdfGenerationService,
    // esbuild (vitest) omits `design:paramtypes`, so ContractPdfService's
    // constructor dep (PdfGenerationService) is wired explicitly via useFactory
    // — otherwise Nest injects `undefined` and generateContractPdf throws.
    {
      provide: ContractPdfService,
      useFactory: (pdfGen: PdfGenerationService) => new ContractPdfService(pdfGen),
      inject: [PdfGenerationService],
    },
    // ContractTemplatesService is a constructor dep of the controller but the
    // preview-pdf route never calls it — provide a no-op stub.
    { provide: ContractTemplatesService, useValue: {} },
    { provide: DatabaseService, useValue: dbMock },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class PreviewPdfTestModule {}

describe('POST /contracts/templates/preview-pdf — ADMIN-only PDF preview (real controller + real PDF)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PreviewPdfTestModule] })
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'contract-preview-pdf-cookie-secret' })
    app.setGlobalPrefix('api')
    app.useGlobalFilters(new ZodExceptionFilter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    jwt = moduleRef.get(JwtService)
  }, 30_000)

  afterAll(async () => {
    await app.close()
  })

  const tokenFor = (u: SessionUser) => jwt.sign(u)

  const BODY_WITH_TOKENS = '# Контракт\n\nИмя: {{employeeName}}\nUSDT: {{walletUsdt}}'

  it('ADMIN → 200 with a valid %PDF document', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/contracts/templates/preview-pdf',
      cookies: { jwt: tokenFor(ADMIN) },
      payload: { bodyMarkdown: BODY_WITH_TOKENS, role: 'SENIOR' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    const buf = res.rawPayload
    expect(buf.length).toBeGreaterThan(1000)
    // PDF magic header.
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('reads the company requisites once for the preview (appended section)', async () => {
    ;(dbMock.db.query.companyAccount.findFirst as ReturnType<typeof vi.fn>).mockClear()
    await app.inject({
      method: 'POST',
      url: '/api/contracts/templates/preview-pdf',
      cookies: { jwt: tokenFor(ADMIN) },
      payload: { bodyMarkdown: BODY_WITH_TOKENS, role: 'SENIOR' },
    })
    expect(dbMock.db.query.companyAccount.findFirst).toHaveBeenCalledTimes(1)
  })

  for (const persona of [ACCOUNTANT, SENIOR, JUNIOR, HR, DROP]) {
    it(`${persona.role} → 403`, async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/contracts/templates/preview-pdf',
        cookies: { jwt: tokenFor(persona) },
        payload: { bodyMarkdown: BODY_WITH_TOKENS, role: 'SENIOR' },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it('empty markdown → 400 (Zod)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/contracts/templates/preview-pdf',
      cookies: { jwt: tokenFor(ADMIN) },
      payload: { bodyMarkdown: '', role: 'SENIOR' },
    })
    expect(res.statusCode).toBe(400)
  })
})
