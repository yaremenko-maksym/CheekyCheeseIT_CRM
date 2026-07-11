import { Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { ZodExceptionFilter } from '../zod-exception.filter'
import { TosController } from './tos.controller'
import { TosService } from './tos.service'
import { TosPdfService } from './tos-pdf.service'
import { PdfGenerationService } from '../common/pdf/pdf-generation.service'

/**
 * Integration test for POST /api/tos/preview-pdf.
 *
 * Stands up the REAL TosController behind the REAL JwtAuthGuard + RolesGuard chain.
 * TosService is stubbed (preview-pdf never calls it).
 * TosPdfService + PdfGenerationService are REAL so a real PDF is produced.
 *
 * Asserts:
 *   - ADMIN → 200 + valid `%PDF` bytes (clean ToS PDF, no contract chrome).
 *   - every non-ADMIN role → 403.
 *   - invalid body (empty markdown) → 400 (Zod).
 *   - Cache-Control: no-store, private header is set.
 *
 * No external DB required — runs anywhere.
 */

const JWT_SECRET = 'tos-preview-pdf-integration-secret-32c'

const base: SessionUser = {
  id: 'a0111111-0000-4000-a000-000000000001',
  email: 'tos-admin@test.spec',
  displayName: 'ToS Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}

const ADMIN = base
const ACCOUNTANT: SessionUser = {
  ...base,
  id: 'a0111111-0000-4000-a000-000000000002',
  email: 'tos-acct@test.spec',
  role: 'ACCOUNTANT',
}
const SENIOR: SessionUser = {
  ...base,
  id: 'a0111111-0000-4000-a000-000000000003',
  email: 'tos-sen@test.spec',
  role: 'SENIOR',
}
const JUNIOR: SessionUser = {
  ...base,
  id: 'a0111111-0000-4000-a000-000000000004',
  email: 'tos-jun@test.spec',
  role: 'JUNIOR',
}
const HR: SessionUser = {
  ...base,
  id: 'a0111111-0000-4000-a000-000000000005',
  email: 'tos-hr@test.spec',
  role: 'HR',
}
const DROP: SessionUser = {
  ...base,
  id: 'a0111111-0000-4000-a000-000000000006',
  email: 'tos-drop@test.spec',
  role: 'DROP',
}

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
  controllers: [TosController],
  providers: [
    Reflector,
    PdfGenerationService,
    // esbuild (vitest) omits `design:paramtypes`, so TosPdfService's
    // constructor dep (PdfGenerationService) must be wired explicitly via
    // useFactory — otherwise Nest injects `undefined` (same pattern as the
    // ContractPreviewPdf integration spec).
    {
      provide: TosPdfService,
      useFactory: (pdfGen: PdfGenerationService) => new TosPdfService(pdfGen),
      inject: [PdfGenerationService],
    },
    // TosService is a constructor dep of the controller but preview-pdf never
    // calls it — provide a no-op stub.
    { provide: TosService, useValue: {} },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class TosPreviewPdfTestModule {}

const SAMPLE_MARKDOWN =
  '# Terms of Service\n\nPlease read carefully.\n\n- Rule 1\n- Rule 2\n\n## Section 2\n\nMore content here.'

describe('POST /tos/preview-pdf — ADMIN-only PDF preview (real controller + real PDF)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TosPreviewPdfTestModule] })
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'tos-preview-pdf-cookie-secret' })
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

  // ── AC1: ADMIN → 200 + valid PDF ─────────────────────────────────────────

  it('AC1: ADMIN → 200 with a valid %PDF document', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tos/preview-pdf',
      cookies: { jwt: tokenFor(ADMIN) },
      payload: { bodyMarkdown: SAMPLE_MARKDOWN },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    const buf = res.rawPayload
    expect(buf.length).toBeGreaterThan(1000)
    // PDF magic header
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('AC1: response includes Cache-Control: no-store, private', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tos/preview-pdf',
      cookies: { jwt: tokenFor(ADMIN) },
      payload: { bodyMarkdown: SAMPLE_MARKDOWN },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toContain('no-store')
  })

  it('AC1: Content-Disposition is inline with filename tos-preview.pdf', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tos/preview-pdf',
      cookies: { jwt: tokenFor(ADMIN) },
      payload: { bodyMarkdown: SAMPLE_MARKDOWN },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('tos-preview.pdf')
  })

  // ── AC2: RBAC — non-ADMIN roles → 403 ────────────────────────────────────

  for (const persona of [ACCOUNTANT, SENIOR, JUNIOR, HR, DROP]) {
    it(`AC2: ${persona.role} → 403`, async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/tos/preview-pdf',
        cookies: { jwt: tokenFor(persona) },
        payload: { bodyMarkdown: SAMPLE_MARKDOWN },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  // ── AC3: Zod validation ───────────────────────────────────────────────────

  it('AC3: empty bodyMarkdown → 400 (Zod)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tos/preview-pdf',
      cookies: { jwt: tokenFor(ADMIN) },
      payload: { bodyMarkdown: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('AC3: missing bodyMarkdown → 400 (Zod)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tos/preview-pdf',
      cookies: { jwt: tokenFor(ADMIN) },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  // ── Unauthenticated → 401 ─────────────────────────────────────────────────

  it('unauthenticated (no JWT cookie) → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tos/preview-pdf',
      payload: { bodyMarkdown: SAMPLE_MARKDOWN },
    })
    expect(res.statusCode).toBe(401)
  })
})
