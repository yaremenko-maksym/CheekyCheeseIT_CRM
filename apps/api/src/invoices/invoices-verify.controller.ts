/**
 * InvoicesVerifyController — PUBLIC verify endpoint.
 *
 *   GET /api/invoices/verify/:transactionId
 *
 * Reachable without any auth/cookies so the QR code printed on the PDF
 * resolves cleanly in any browser. The response intentionally excludes
 * private fields (full pdf hash, ip address, user-agent) — see
 * `InvoicesService.verifyInvoice` for the projection rules.
 *
 * Why a separate controller (not @Public() + reflection):
 *   The project does not have a global JwtAuthGuard nor a `@Public()`
 *   decorator infrastructure today. The simplest "opt-out" of auth is to
 *   live on a controller that does NOT declare `@UseGuards(JwtAuthGuard)`.
 *   Path is namespaced under `invoices/verify/:id` so the route ordering
 *   does not conflict with the authenticated `:transactionId` route on the
 *   sibling InvoicesController (NestJS picks the more specific match
 *   regardless of declaration order, but using a distinct path segment
 *   removes any ambiguity).
 */
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common'
import { InvoicesService } from './invoices.service'

@Controller('invoices')
export class InvoicesVerifyController {
  constructor(private readonly svc: InvoicesService) {}

  @Get('verify/:transactionId')
  verify(@Param('transactionId', ParseUUIDPipe) transactionId: string) {
    return this.svc.verifyInvoice(transactionId)
  }
}
