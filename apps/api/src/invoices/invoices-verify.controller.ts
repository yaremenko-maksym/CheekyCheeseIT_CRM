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
 * Marked `@Public()` so the globally registered JwtAuthGuard (AppModule
 * APP_GUARD) does not 401 the request. The path is namespaced under
 * `invoices/verify/:id` so it does not collide with the authenticated
 * `:transactionId` route on the sibling InvoicesController.
 */
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common'
import { Public } from '../auth/public.decorator'
import { InvoicesService } from './invoices.service'

@Controller('invoices')
export class InvoicesVerifyController {
  constructor(private readonly svc: InvoicesService) {}

  @Get('verify/:transactionId')
  @Public()
  verify(@Param('transactionId', ParseUUIDPipe) transactionId: string) {
    return this.svc.verifyInvoice(transactionId)
  }
}
