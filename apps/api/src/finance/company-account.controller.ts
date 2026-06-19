import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  createCompanyDepositSchema,
  createDividendSchema,
  updateWalletSchema,
  type SessionUser,
} from '@crm/shared'
import { Throttle } from '@nestjs/throttler'
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
  // Explicit @Inject so this REAL controller can be instantiated by Nest's DI in
  // the vitest/esbuild test env (which does not emit `design:paramtypes`). This
  // lets the RBAC integration spec exercise THIS controller's guards directly,
  // not a sentinel copy (green-wash fix H2, #157/#158/#227 class). No-op in prod.
  constructor(@Inject(CompanyAccountService) private readonly svc: CompanyAccountService) {}

  @Get()
  @Roles('ADMIN', 'ACCOUNTANT')
  getAccount(@CurrentUser() user: SessionUser) {
    return this.svc.getAccount(user)
  }

  @Patch('wallet')
  @Roles('ADMIN')
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // M2: rare admin op, tighten vs 100/min
  updateWallet(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const dto = updateWalletSchema.parse(body)
    return this.svc.updateWallet(dto.walletAddress, user)
  }

  @Post('deposits')
  @Roles('SENIOR', 'DROP')
  @Throttle({ default: { limit: 12, ttl: 60_000 } }) // M2: money-write, tighten vs 100/min
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
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // M2: rare money-out op, tighten vs 100/min
  createDividend(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const dto = createDividendSchema.parse(body)
    return this.svc.createDividend(dto, user)
  }
}
