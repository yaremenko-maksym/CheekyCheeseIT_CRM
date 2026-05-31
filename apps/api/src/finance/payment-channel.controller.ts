/**
 * Drop role - phase 4-B. Endpoints for the three payment channels.
 *
 *   POST /api/payments/initiate-crypto  → recipients (senior + 2 admins) + wallets
 *   POST /api/payments/confirm-crypto   → creates 3 INCOME rows, closes PAYOUT
 *   POST /api/payments/initiate-bank    → ТОВ banking details + reference
 *   POST /api/payments/confirm-bank     → creates TOV_INCOME + SENIOR_PENDING_PAYOUT
 *   POST /api/payments/initiate-cash    → creates ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT
 *
 * RBAC is enforced inside `PaymentChannelService` so the controller stays
 * thin. Each handler parses the body through the shared Zod schema before
 * delegating.
 */
import { Body, Controller, Post, UseGuards } from '@nestjs/common'
import {
  confirmBankPaymentSchema,
  confirmCryptoPaymentSchema,
  initiateBankPaymentSchema,
  initiateCashPaymentSchema,
  initiateCryptoPaymentSchema,
} from '@crm/shared'
import type { SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { PaymentChannelService } from './payment-channel.service'

@UseGuards(JwtAuthGuard)
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

  @Post('initiate-bank')
  initiateBank(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = initiateBankPaymentSchema.parse(body)
    return this.svc.initiateBankPayment(data.incomeId, user)
  }

  @Post('confirm-bank')
  confirmBank(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = confirmBankPaymentSchema.parse(body)
    return this.svc.confirmBankPayment(data.incomeId, user)
  }

  @Post('initiate-cash')
  initiateCash(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = initiateCashPaymentSchema.parse(body)
    return this.svc.initiateCashPayment(data.incomeId, data.recipientAdminId, user)
  }
}
