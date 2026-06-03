/**
 * Drop role - phase 4 (refactor — task-drop-phase4-refactor-remove-tov.md).
 *
 * Endpoints for the two remaining payment channels:
 *
 *   POST /api/payments/initiate-crypto  → recipients (senior + 2 admins) + wallets
 *   POST /api/payments/confirm-crypto   → creates 3 INCOME rows, closes PAYOUT
 *   POST /api/payments/confirm-cash     → admin-initiated cash flow:
 *                                         ACCOUNTANT/ADMIN logs that cash was
 *                                         received by a chosen admin partner;
 *                                         creates ADMIN_INCOME_CASH +
 *                                         SENIOR_PENDING_PAYOUT and flips/
 *                                         creates the PAYOUT row → PAID.
 *
 * Removed in the refactor (AC1, AC2):
 *   - POST /api/payments/initiate-bank, /confirm-bank  (bank channel gone)
 *   - POST /api/payments/initiate-cash                  (drop-initiated cash gone)
 *   - GET  /api/payments/pending-cash                   (no PENDING_CASH_CONFIRM
 *                                                       intermediate list)
 *
 * RBAC is enforced inside `PaymentChannelService` so the controller stays
 * thin. Each handler parses the body through the shared Zod schema before
 * delegating.
 */
import { Body, Controller, Post } from '@nestjs/common'
import {
  confirmCashPaymentSchema,
  confirmCryptoPaymentSchema,
  initiateCryptoPaymentSchema,
} from '@crm/shared'
import type { SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { PaymentChannelService } from './payment-channel.service'

// Auth enforced by global JwtAuthGuard (see AppModule APP_GUARD).
@Controller('payments')
export class PaymentChannelController {
  constructor(private readonly svc: PaymentChannelService) {}

  @Post('initiate-crypto')
  initiateCrypto(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = initiateCryptoPaymentSchema.parse(body)
    return this.svc.initiateCryptoPayment(data.incomeId, user)
  }

  @Post('confirm-crypto')
  confirmCrypto(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = confirmCryptoPaymentSchema.parse(body)
    return this.svc.confirmCryptoPayment(data.incomeId, data.txHashes, user)
  }

  @Post('confirm-cash')
  confirmCash(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = confirmCashPaymentSchema.parse(body)
    return this.svc.confirmCashPayment(data.incomeId, data.recipientAdminId, user)
  }
}
