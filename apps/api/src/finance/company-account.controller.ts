import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common'
import {
  createCompanyDepositSchema,
  createDividendSchema,
  updateWalletSchema,
  type SessionUser,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { CompanyAccountService } from './company-account.service'

/**
 * task-company-account-backend — /api/company-account.
 *
 * Defense-in-depth RBAC: `@UseGuards(RolesGuard)` + `@Roles(...)` gate at the
 * HTTP boundary (returns 403 before the handler runs), AND the service re-checks
 * the role (so the guarantee survives even if the controller decorator is ever
 * dropped — the #157/#158 lesson). JwtAuthGuard runs globally (AppModule
 * APP_GUARD) so authentication is already covered.
 *
 * Route → allowed roles:
 *   GET    /company-account              ADMIN | ACCOUNTANT
 *   PATCH  /company-account/wallet       ADMIN
 *   POST   /company-account/deposits     SENIOR | DROP
 *   GET    /company-account/deposits/:id/status   SENIOR | DROP | ADMIN | ACCOUNTANT (owner|priv — service)
 *   POST   /company-account/dividends    ADMIN
 */
@Controller('company-account')
@UseGuards(RolesGuard)
export class CompanyAccountController {
  constructor(private readonly svc: CompanyAccountService) {}

  @Get()
  @Roles('ADMIN', 'ACCOUNTANT')
  getAccount(@CurrentUser() user: SessionUser) {
    return this.svc.getAccount(user)
  }

  @Patch('wallet')
  @Roles('ADMIN')
  updateWallet(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const dto = updateWalletSchema.parse(body)
    return this.svc.updateWallet(dto.walletAddress, user)
  }

  @Post('deposits')
  @Roles('SENIOR', 'DROP')
  submitDeposit(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const dto = createCompanyDepositSchema.parse(body)
    return this.svc.submitDeposit(dto, user)
  }

  // Owner OR ADMIN/ACCOUNTANT — the flat guard admits every role that could be
  // an owner-or-privileged caller; the service enforces the precise
  // owner-vs-privileged decision (a SENIOR/DROP who is not the owner → 403).
  @Get('deposits/:id/status')
  @Roles('SENIOR', 'DROP', 'ADMIN', 'ACCOUNTANT')
  getDepositStatus(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.svc.getDepositStatus(id, user)
  }

  @Post('dividends')
  @Roles('ADMIN')
  createDividend(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const dto = createDividendSchema.parse(body)
    return this.svc.createDividend(dto, user)
  }
}
