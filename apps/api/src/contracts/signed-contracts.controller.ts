import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { Throttle } from '@nestjs/throttler'

import { signContractSchema, type SessionUser } from '@crm/shared'
import { SensitiveWriteThrottle } from '../config/throttle-decorators'
import { CurrentUser } from '../auth/current-user.decorator'
import { SignedContractsService } from './signed-contracts.service'
import { ContractPdfService } from './contract-pdf.service'
import { EmployeeContractsService } from './employee-contracts.service'

/**
 * Sign / read signed-contracts endpoints.
 *
 * RBAC:
 *   POST /api/contracts/sign           — any authenticated non-ADMIN
 *   GET  /api/contracts/me             — caller's own signed contracts
 *   GET  /api/contracts/me/status      — caller's employee_contract status (AC1 fix)
 *   GET  /api/contracts/:id            — ADMIN | ACCOUNTANT | owner
 *   GET  /api/contracts/:id/pdf        — owner | ADMIN | ACCOUNTANT
 *
 * A3-1: GET /api/contracts/preview-pdf REMOVED — replaced by per-employee
 * contract PDF endpoints:
 *   - GET /api/users/:id/contract/pdf   (ADMIN)
 *   - GET /api/onboarding/contract/pdf  (self, bypass-listed)
 *
 * Auth enforced by global JwtAuthGuard (AppModule APP_GUARD). `/sign` lives
 * in the OnboardingGuard bypass list so users mid-onboarding can submit it
 * (they have no signed contract yet by definition).
 *
 * IP / UA captured server-side from the Fastify request (`req.ip` +
 * `req.headers['user-agent']`), never trusted from client body.
 */
@Controller('contracts')
export class SignedContractsController {
  constructor(
    private readonly service: SignedContractsService,
    private readonly contractPdf: ContractPdfService,
    private readonly employeeContracts: EmployeeContractsService,
  ) {}

  // Signing a contract is a one-time user action — 10 req/min prevents
  // automated replay without breaking real onboarding retries.
  // In non-production with THROTTLE_RELAXED=true the limit is raised to the
  // global ceiling (see apps/api/src/config/throttle-decorators.ts).
  @Post('sign')
  @SensitiveWriteThrottle()
  sign(@Body() body: unknown, @CurrentUser() user: SessionUser, @Req() request: FastifyRequest) {
    const { typedName } = signContractSchema.parse(body)
    const ip = (request.ip as string | undefined) ?? null
    const userAgent = (request.headers['user-agent'] as string | undefined)?.slice(0, 1000) ?? null

    return this.service.sign({
      userId: user.id,
      userRole: user.role,
      typedName,
      ip,
      userAgent,
    })
  }

  @Get('me')
  findMine(@CurrentUser() user: SessionUser) {
    return this.service.findMine(user.id)
  }

  /**
   * GET /api/contracts/me/status — self-only employee_contract status.
   *
   * AC1 fix: the JUNIOR hub was reading GET /contracts/me (signed_contracts list)
   * which returned rows WITHOUT a `status` field — causing contractMeDtoSchema.parse()
   * to throw, query to land in error state, and the card to render «Контракт не оформлен»
   * even for SIGNED users.
   *
   * This endpoint reads employee_contracts.status directly.
   * Returns null (HTTP 200 with null body) when no active contract exists yet.
   * Self-only by construction — userId comes from JWT, no param accepted.
   */
  @Get('me/status')
  async getMyContractStatus(@CurrentUser() user: SessionUser) {
    return this.employeeContracts.getMyStatus(user.id)
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.service.findById(id, user)
  }

  /**
   * Download a signed contract as a PDF. RBAC is enforced inside
   * `getPdfData` → `findById` (owner | ADMIN | ACCOUNTANT).
   *
   * Uses `@Res()` to stream the binary directly — bypasses the global
   * serializer interceptor (which would try to JSON-encode the Buffer).
   */
  @Get(':id/pdf')
  @Header('Cache-Control', 'no-store, private')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async downloadPdf(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const data = await this.service.getPdfData(id, user)
    const { pdfBuffer } = await this.contractPdf.generateContractPdf(data)

    // task-junior-ut-round2 §7: lazily persist the real PDF size so the documents
    // list shows it instead of 0 B. Best-effort — a write failure must not block
    // the download.
    void this.service.recordPdfSizeIfAbsent(id, pdfBuffer.length).catch(() => {})

    await reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="contract-${data.contractNumber}.pdf"`)
      .send(pdfBuffer)
  }
}
