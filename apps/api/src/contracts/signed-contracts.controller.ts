import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { Throttle } from '@nestjs/throttler'

import { signContractSchema, type SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { SignedContractsService } from './signed-contracts.service'
import { ContractPdfService } from './contract-pdf.service'

/**
 * Sign / read signed-contracts endpoints.
 *
 * RBAC:
 *   POST /api/contracts/sign       — any authenticated non-ADMIN
 *   GET  /api/contracts/me         — caller's own signed contracts
 *   GET  /api/contracts/:id        — ADMIN | ACCOUNTANT | owner
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
  ) {}

  // Signing a contract is a one-time user action — 10 req/min prevents
  // automated replay without breaking real onboarding retries.
  @Post('sign')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
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

    await reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="contract-${data.contractNumber}.pdf"`)
      .send(pdfBuffer)
  }
}
