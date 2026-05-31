import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import {
  adminUpdateTransactionSchema,
  createAdminIncomeSchema,
  createAdminTransferSchema,
  createDropIncomeSchema,
  createExpenseSchema,
  createPayoutRequestSchema,
  createSeniorIncomeSchema,
  createSalarySchema,
  payPayoutRequestSchema,
  paySalarySchema,
  updateProjectFinanceSettingsSchema,
  updateSeniorIncomeSchema,
  validateTransactionSchema,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { NbuCurrencyService } from './nbu-currency.service'
import { TransactionsService } from './transactions.service'

@UseGuards(JwtAuthGuard)
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly svc: TransactionsService) {}

  @Get()
  findAll(
    @CurrentUser() user: SessionUser,
    @Query('type') type: string | undefined,
    @Query('status') status: string | undefined,
    @Query('projectId') projectId: string | undefined,
    @Query('seniorId') seniorId: string | undefined,
    @Query('month') month: string | undefined,
  ) {
    return this.svc.findAll(user, {
      ...(type !== undefined && { type }),
      ...(status !== undefined && { status }),
      ...(projectId !== undefined && { projectId }),
      ...(seniorId !== undefined && { seniorId }),
      ...(month !== undefined && { month }),
    })
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.findOne(id, user)
  }

  @Post('admin-income')
  createAdminIncome(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createAdminIncome(
      createAdminIncomeSchema.parse(body) as Parameters<
        TransactionsService['createAdminIncome']
      >[0],
      user,
    )
  }

  @Post('senior-income')
  createSeniorIncome(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createSeniorIncome(
      createSeniorIncomeSchema.parse(body) as Parameters<
        TransactionsService['createSeniorIncome']
      >[0],
      user,
    )
  }

  // Drop role - phase 2. Parallel endpoint for DROP role only — service
  // enforces RBAC (DROP role + project.dropId === caller.id). The frontend
  // can call the same shape as senior-income.
  @Post('drop-income')
  createDropIncome(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createDropIncome(
      createDropIncomeSchema.parse(body) as Parameters<TransactionsService['createDropIncome']>[0],
      user,
    )
  }

  @Patch('senior-income/:id')
  updateSeniorIncome(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.svc.updateSeniorIncome(
      id,
      updateSeniorIncomeSchema.parse(body) as Parameters<
        TransactionsService['updateSeniorIncome']
      >[1],
      user,
    )
  }

  @Post('expense')
  createExpense(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createExpense(
      createExpenseSchema.parse(body) as Parameters<TransactionsService['createExpense']>[0],
      user,
    )
  }

  @Post('salary')
  createSalary(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createSalary(
      createSalarySchema.parse(body) as Parameters<TransactionsService['createSalary']>[0],
      user,
    )
  }

  @Post('admin-transfer')
  createAdminTransfer(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createAdminTransfer(
      createAdminTransferSchema.parse(body) as Parameters<
        TransactionsService['createAdminTransfer']
      >[0],
      user,
    )
  }

  @Patch(':id/validate')
  validate(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = validateTransactionSchema.parse(body)
    return this.svc.validateTransaction(id, data.action, data.rejectionReason, user)
  }

  @Patch(':id/pay')
  paySalary(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.paySalary(id, paySalarySchema.parse(body), user)
  }

  @Patch(':id/admin-edit')
  adminEdit(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.adminUpdateTransaction(id, adminUpdateTransactionSchema.parse(body), user)
  }

  @Delete(':id')
  @HttpCode(200)
  adminDelete(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.adminDeleteTransaction(id, user)
  }
}

@UseGuards(JwtAuthGuard)
@Controller('payout-requests')
export class PayoutRequestsController {
  constructor(private readonly svc: TransactionsService) {}

  @Get()
  findAll(@CurrentUser() user: SessionUser) {
    return this.svc.findPayoutRequests(user)
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.findPayoutRequest(id, user)
  }

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createPayoutRequest(createPayoutRequestSchema.parse(body).transactionIds, user)
  }

  @Patch(':id/pay')
  pay(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = payPayoutRequestSchema.parse(body)
    // simulateResult is a DEV-only escape hatch: forwarded only when the
    // client opted in, so production builds (which can't render the toggle)
    // call the original 3-arg overload. The service ignores it outside of
    // NODE_ENV !== 'production' regardless. txHash is optional in simulate
    // mode — service synthesizes a stub when absent.
    if (data.simulateResult !== undefined) {
      return this.svc.payPayoutRequest(id, data.txHash, user, data.simulateResult)
    }
    return this.svc.payPayoutRequest(id, data.txHash, user)
  }
}

@UseGuards(JwtAuthGuard)
@Controller('finance')
export class FinanceSummaryController {
  constructor(
    private readonly svc: TransactionsService,
    private readonly nbu: NbuCurrencyService,
  ) {}

  @Get('summary')
  getSummary(@CurrentUser() user: SessionUser) {
    return this.svc.getSummary(user)
  }

  // ?date=YYYYMMDD — optional, defaults to today
  @Get('exchange-rate')
  getExchangeRate(@Query('date') date: string | undefined) {
    return this.nbu.getRates(date)
  }
}

@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/finance-settings')
export class ProjectFinanceSettingsController {
  constructor(private readonly svc: TransactionsService) {}

  @Get()
  get(@Param('projectId') projectId: string, @CurrentUser() user: SessionUser) {
    return this.svc.getProjectFinanceSettings(projectId, user)
  }

  @Patch()
  upsert(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.svc.upsertProjectFinanceSettings(
      projectId,
      updateProjectFinanceSettingsSchema.parse(body),
      user,
    )
  }
}
