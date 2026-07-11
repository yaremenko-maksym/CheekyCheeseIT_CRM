import { Body, Controller, Get, Header, Inject, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { Throttle } from '@nestjs/throttler'

import { createTosVersionSchema, tosPdfPreviewSchema, type SessionUser } from '@crm/shared'
import { AdminWriteThrottle, SensitiveWriteThrottle } from '../config/throttle-decorators'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { TosService } from './tos.service'
import { TosPdfService } from './tos-pdf.service'

/**
 * Terms of Service endpoints.
 *
 * | Endpoint                     | Allowed roles  | OnboardingGuard bypass |
 * | ---------------------------- | -------------- | ---------------------- |
 * | GET    /api/tos/current      | any authn'd    | YES                    |
 * | GET    /api/tos/versions     | ADMIN          | NO                     |
 * | POST   /api/tos              | ADMIN          | NO                     |
 * | POST   /api/tos/accept       | any authn'd    | YES                    |
 * | POST   /api/tos/preview-pdf  | ADMIN          | NO                     |
 *
 * `current` and `accept` are in the bypass list because mid-onboarding users
 * need them to fulfill the gate.
 */
// JwtAuthGuard runs globally (AppModule APP_GUARD); RolesGuard stays
// controller-level because it depends on `req.user.role` populated by the
// global guard.
@Controller('tos')
@UseGuards(RolesGuard)
export class TosController {
  constructor(
    @Inject(TosService) private readonly service: TosService,
    @Inject(TosPdfService) private readonly tosPdf: TosPdfService,
  ) {}

  @Get('current')
  current() {
    return this.service.getCurrent()
  }

  @Get('versions')
  @Roles('ADMIN')
  list() {
    return this.service.listAll()
  }

  // Publishing a new ToS version is a sensitive admin write — 5 req/min.
  // Raised to global limit in non-prod when THROTTLE_RELAXED=true.
  @Post()
  @Roles('ADMIN')
  @AdminWriteThrottle()
  publish(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const { bodyMarkdown } = createTosVersionSchema.parse(body)
    return this.service.publish({ bodyMarkdown, createdByUserId: user.id })
  }

  // ToS acceptance is a user action during onboarding — 10 req/min allows
  // retry after network errors without enabling replay attacks.
  // Raised to global limit in non-prod when THROTTLE_RELAXED=true.
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @SensitiveWriteThrottle()
  accept(@CurrentUser() user: SessionUser, @Req() request: FastifyRequest) {
    const ip = (request.ip as string | undefined) ?? null
    const userAgent = (request.headers['user-agent'] as string | undefined)?.slice(0, 1000) ?? null
    return this.service.accept({ userId: user.id, ip, userAgent })
  }

  /**
   * POST /api/tos/preview-pdf
   *
   * Live-renders the provided markdown as a clean ToS PDF (no contract chrome).
   * ADMIN-only — the admin ToS editor uses this for the split-view right pane.
   *
   * Rate-limit: 20 req/min — PDF generation is CPU-intensive.
   * Cache-Control: no-store — preview is always fresh (body changes on each keystroke).
   */
  @Post('preview-pdf')
  @Roles('ADMIN')
  @Header('Cache-Control', 'no-store, private')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async previewPdf(@Body() body: unknown, @Res() reply: FastifyReply): Promise<void> {
    const { bodyMarkdown } = tosPdfPreviewSchema.parse(body)
    const pdfBuffer = await this.tosPdf.generateTosPdf(bodyMarkdown)

    await reply
      .code(200)
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'inline; filename="tos-preview.pdf"')
      .send(pdfBuffer)
  }
}
