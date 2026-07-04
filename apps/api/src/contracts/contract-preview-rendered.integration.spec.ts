import { Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { ZodExceptionFilter } from '../zod-exception.filter'
import { DatabaseService } from '../database/database.service'
import { ContractTemplatesController } from './contract-templates.controller'
import { ContractTemplatesService } from './contract-templates.service'
import { ContractPdfService } from './contract-pdf.service'
import { PdfGenerationService } from '../common/pdf/pdf-generation.service'

/**
 * SEC-12 — GET /api/contracts/templates/preview-rendered/:templateId
 *
 * Verifies that the ADMIN/HR-only role gate on `previewRendered` is enforced
 * by the real RolesGuard (not a mock). Non-ADMIN/HR roles must receive 403.
 *
 * DatabaseService is mocked:
 *   - ContractTemplatesService.getById → returns a canned template.
 *   - db.query.users.findFirst        → returns a minimal user row.
 *
 * No live DB required.
 */

const JWT_SECRET = 'contract-preview-rendered-sec12-secret-32c'

const base: SessionUser = {
  id: 'aa000001-0000-4000-a000-000000000001',
  email: 'pr-admin@test.spec',
  displayName: 'PR Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ADMIN: SessionUser = { ...base, role: 'ADMIN' }
const HR: SessionUser = {
  ...base,
  id: 'aa000002-0000-4000-a000-000000000002',
  email: 'pr-hr@test.spec',
  role: 'HR',
}
const ACCOUNTANT: SessionUser = {
  ...base,
  id: 'aa000003-0000-4000-a000-000000000003',
  email: 'pr-acct@test.spec',
  role: 'ACCOUNTANT',
}
const SENIOR: SessionUser = {
  ...base,
  id: 'aa000004-0000-4000-a000-000000000004',
  email: 'pr-sen@test.spec',
  role: 'SENIOR',
}
const JUNIOR: SessionUser = {
  ...base,
  id: 'aa000005-0000-4000-a000-000000000005',
  email: 'pr-jun@test.spec',
  role: 'JUNIOR',
}
const DROP: SessionUser = {
  ...base,
  id: 'aa000006-0000-4000-a000-000000000006',
  email: 'pr-drop@test.spec',
  role: 'DROP',
}

const TEMPLATE_ID = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee'
const TEMPLATE_BODY = '# Контракт\n\nПідписант: {{employeeName}}'

const dbMock = {
  db: {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: ADMIN.id,
          displayName: 'PR Admin',
          email: 'pr-admin@test.spec',
          legalFullName: null,
          registrationAddress: null,
          usrRecord: null,
          walletUsdtErc20: null,
          walletUsdtLabel: null,
          bankUahRecipient: null,
          bankUahIban: null,
          bankUahRnokpp: null,
          bankUahBankName: null,
        }),
      },
    },
  },
} as unknown as DatabaseService

const serviceStub = {
  getById: vi.fn().mockResolvedValue({
    id: TEMPLATE_ID,
    bodyMarkdown: TEMPLATE_BODY,
    role: 'SENIOR',
    version: 1,
    createdAt: new Date().toISOString(),
  }),
  listAll: vi.fn(),
  getCurrentForRole: vi.fn(),
} as unknown as ContractTemplatesService

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
  controllers: [ContractTemplatesController],
  providers: [
    Reflector,
    PdfGenerationService,
    {
      provide: ContractPdfService,
      useFactory: (p: PdfGenerationService) => new ContractPdfService(p),
      inject: [PdfGenerationService],
    },
    { provide: ContractTemplatesService, useValue: serviceStub },
    { provide: DatabaseService, useValue: dbMock },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class PreviewRenderedTestModule {}

describe('GET /contracts/templates/preview-rendered/:id — ADMIN/HR only (SEC-12)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PreviewRenderedTestModule] })
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'preview-rendered-cookie-secret' })
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
  const url = `/api/contracts/templates/preview-rendered/${TEMPLATE_ID}`

  it('ADMIN → 200 with rendered bodyMarkdown', async () => {
    const res = await app.inject({
      method: 'GET',
      url,
      cookies: { jwt: tokenFor(ADMIN) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ bodyMarkdown: string }>()
    expect(typeof body.bodyMarkdown).toBe('string')
    expect(body.bodyMarkdown.length).toBeGreaterThan(0)
  })

  it('HR → 200 with rendered bodyMarkdown', async () => {
    const res = await app.inject({
      method: 'GET',
      url,
      cookies: { jwt: tokenFor(HR) },
    })
    expect(res.statusCode).toBe(200)
  })

  for (const persona of [ACCOUNTANT, SENIOR, JUNIOR, DROP]) {
    it(`${persona.role} → 403 (no access to preview-rendered)`, async () => {
      const res = await app.inject({
        method: 'GET',
        url,
        cookies: { jwt: tokenFor(persona) },
      })
      expect(res.statusCode).toBe(403)
    })
  }
})
