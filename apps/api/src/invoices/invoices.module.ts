/**
 * InvoicesModule — wires the Invoice Signing Epic.
 *
 *   - `InvoicePdfService` was added in Round 2 (commit 60a09ae). We register
 *     it here so the same module exports the full Invoice surface (PDF gen +
 *     CRUD + sign + verify). FinanceModule injects `InvoicesService` to
 *     trigger auto-create after the relevant transaction transitions; that
 *     cross-module dependency is wired via forwardRef on the FinanceModule
 *     side to avoid a circular import at boot.
 *   - DocumentsModule supplies `DocumentsService` + `S3Service` for the
 *     PDF storage + retrieve flow.
 *   - NotificationsModule supplies `NotificationsService` for the
 *     `INVOICE_SIGN_REQUIRED` / `INVOICE_SIGNED` emitter calls.
 *   - AuthModule is forwardRef'd for JwtAuthGuard on the authenticated
 *     controller (verify controller does NOT use the guard).
 */
import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { DocumentsModule } from '../documents/documents.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { InvoicePdfService } from './invoice-pdf.service'
import { InvoicesController } from './invoices.controller'
import { InvoicesService } from './invoices.service'
import { InvoicesVerifyController } from './invoices-verify.controller'

@Module({
  imports: [DatabaseModule, forwardRef(() => AuthModule), DocumentsModule, NotificationsModule],
  controllers: [InvoicesController, InvoicesVerifyController],
  providers: [InvoicesService, InvoicePdfService],
  exports: [InvoicesService, InvoicePdfService],
})
export class InvoicesModule {}
