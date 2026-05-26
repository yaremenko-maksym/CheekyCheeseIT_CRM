/**
 * InvoicesController — HTTP surface for the Invoice Signing Epic.
 *
 * Endpoints (all prefixed `/api/invoices`):
 *   GET   /                          list (filters: status, type)
 *   GET   /:transactionId            detail (signatures + counterparty)
 *   POST  /:transactionId/sign       counterparty signing
 *
 * Public verification — `/api/invoices/verify/:transactionId` — lives in a
 * separate controller (`InvoicesVerifyController`) so it can skip the global
 * JwtAuthGuard. Splitting controllers is the simplest way to opt out of
 * @UseGuards in NestJS without introducing a `@Public()` decorator + a
 * reflection-aware guard.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { invoiceListFiltersSchema, signInvoiceRequestSchema, type SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { InvoicesService } from './invoices.service'

@Controller('invoices')
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(private readonly svc: InvoicesService) {}

  // ---------------------------------------------------------------------------
  // GET /api/invoices
  // ---------------------------------------------------------------------------

  @Get()
  list(
    @CurrentUser() user: SessionUser,
    @Query('status') status: string | undefined,
    @Query('type') type: string | undefined,
  ) {
    const filters = invoiceListFiltersSchema.parse({
      status: status || undefined,
      type: type || undefined,
    })
    return this.svc.listInvoices(user, filters)
  }

  // ---------------------------------------------------------------------------
  // GET /api/invoices/:transactionId
  // ---------------------------------------------------------------------------

  @Get(':transactionId')
  detail(
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.svc.getInvoice(user, transactionId)
  }

  // ---------------------------------------------------------------------------
  // POST /api/invoices/:transactionId/sign
  // ---------------------------------------------------------------------------

  @Post(':transactionId/sign')
  sign(
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionUser,
  ) {
    // Body is an empty object today (server reads ip + user-agent from req).
    // Parsing still — gives us forward-compat when v2 adds acknowledgement
    // flags.
    signInvoiceRequestSchema.parse(body ?? {})
    return this.svc.signInvoice(user, transactionId, req)
  }
}
