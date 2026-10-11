import { Module, forwardRef } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { DocumentsModule } from '../documents/documents.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { BalanceController, PendingObligationsController } from './balance.controller'
import { BalanceService } from './balance.service'
import { CompanyAccountController } from './company-account.controller'
import { CompanyAccountService } from './company-account.service'
import { EditCascadeService } from './edit-cascade.service'
import { DropSelfService } from './drop-self.service'
import { OnChainClaimService } from './onchain-claim.service'
import { EtherscanService } from './etherscan.service'
import { NbuCurrencyService } from './nbu-currency.service'
import { PayoutRequestReadService } from './payout-request-read.service'
import { PayoutRequestService } from './payout-request.service'
import { PayoutSettlementService } from './payout-settlement.service'
import { AdminIncomeService } from './admin-income.service'
import { TransactionEntryService } from './transaction-entry.service'
import { SalaryPaymentService } from './salary-payment.service'
import { AdminEditService } from './admin-edit.service'
import { PendingSettlementController } from './pending-settlement.controller'
import { PendingSettlementService } from './pending-settlement.service'
import { SalaryCronService } from './salary-cron.service'
import { SalaryService } from './salary.service'
import { SummaryService } from './summary.service'
import {
  FinanceSummaryController,
  PayoutRequestsController,
  ProjectFinanceSettingsController,
  TransactionsController,
} from './transactions.controller'
import { TransactionLifecycleService } from './transaction-lifecycle.service'
import { TransactionsService } from './transactions.service'
import { TransactionTrashService } from './transaction-trash.service'

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => AuthModule),
    ScheduleModule.forRoot(),
    // forwardRef avoids a boot-time circular import: InvoicesService doesn't
    // import FinanceModule directly, but the Documents/Notifications wiring
    // pulled through InvoicesModule transitively touches a graph that
    // includes FinanceModule via Documents tests — keeping the ref lazy
    // means Nest resolves the providers in the correct order at runtime.
    forwardRef(() => InvoicesModule),
    // DocumentsModule is needed for DocumentsService.hardDeleteInternal —
    // used by TransactionsService.updateSeniorIncome (receipt replace-with-delete).
    // forwardRef guards against potential circular import chains through
    // InvoicesModule → DocumentsModule → … paths.
    forwardRef(() => DocumentsModule),
    // task-notification-types-producers (позиция 6). TransactionsService —
    // производитель двух типов уведомлений. NotificationsModule зависит только
    // от DatabaseModule, поэтому цикла здесь нет и forwardRef не нужен.
    NotificationsModule,
  ],
  providers: [
    TransactionsService,
    EtherscanService,
    SalaryCronService,
    // T-L6: db-only salary logic collaborator of TransactionsService.
    SalaryService,
    // T-L8: read-only summaries (db + NBU rates only; never depends on TransactionsService).
    SummaryService,
    // Post-write lifecycle collaborator: notifications, creation audit, auto-invoice
    // (NotificationsService + InvoicesService + db; never depends on TransactionsService).
    TransactionLifecycleService,
    // Soft-delete / restore / audit-log read collaborator (db only).
    TransactionTrashService,
    // Edit-cascade core: row locks, cascade snapshot, apply, preview (db only).
    EditCascadeService,
    // Self-only DROP read path: summary, incomes and payments feeds (db + NBU rates only).
    DropSelfService,
    OnChainClaimService,
    // Payout-request read path: role-scoped list + masked detail (db only).
    PayoutRequestReadService,
    PayoutRequestService,
    PayoutSettlementService,
    AdminIncomeService,
    TransactionEntryService,
    SalaryPaymentService,
    AdminEditService,
    NbuCurrencyService,
    // Phase 4-A: balance pipeline runs alongside the legacy getSummary.
    BalanceService,
    // task-drop-payout-company-account: legacy PaymentChannelService removed —
    // drop now settles via the same createPayoutRequest → payPayoutRequest flow
    // as a senior (company account + COMPANY → senior obligation in the cascade).
    // Phase 4-C: pending senior IOU settlement (close company debts to seniors).
    PendingSettlementService,
    // task-company-account-backend: shared company USDT account.
    CompanyAccountService,
  ],
  controllers: [
    TransactionsController,
    PayoutRequestsController,
    FinanceSummaryController,
    ProjectFinanceSettingsController,
    // Phase 4-A: /api/balances/{tov,admin,senior} + /api/pending-obligations
    BalanceController,
    PendingObligationsController,
    // Phase 4-C: /api/pending-settlements/{senior,company,:id/settle-company}
    PendingSettlementController,
    // task-company-account-backend: /api/company-account/*
    CompanyAccountController,
  ],
  exports: [TransactionsService, BalanceService, PendingSettlementService, CompanyAccountService],
})
export class FinanceModule {}
