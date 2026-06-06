import { Module, forwardRef } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { DocumentsModule } from '../documents/documents.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { BalanceController, PendingObligationsController } from './balance.controller'
import { BalanceService } from './balance.service'
import { EtherscanService } from './etherscan.service'
import { NbuCurrencyService } from './nbu-currency.service'
import { PaymentChannelController } from './payment-channel.controller'
import { PaymentChannelService } from './payment-channel.service'
import { PendingSettlementController } from './pending-settlement.controller'
import { PendingSettlementService } from './pending-settlement.service'
import { SalaryCronService } from './salary-cron.service'
import {
  FinanceSummaryController,
  PayoutRequestsController,
  ProjectFinanceSettingsController,
  TransactionsController,
} from './transactions.controller'
import { TransactionsService } from './transactions.service'

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
  ],
  providers: [
    TransactionsService,
    EtherscanService,
    SalaryCronService,
    NbuCurrencyService,
    // Phase 4-A: balance pipeline runs alongside the legacy getSummary.
    BalanceService,
    // Phase 4-B: drop-project payment channels (crypto/bank/cash).
    PaymentChannelService,
    // Phase 4-C: pending senior IOU settlement (close TOV/DROP debts).
    PendingSettlementService,
  ],
  controllers: [
    TransactionsController,
    PayoutRequestsController,
    FinanceSummaryController,
    ProjectFinanceSettingsController,
    // Phase 4-A: /api/balances/{tov,admin,senior} + /api/pending-obligations
    BalanceController,
    PendingObligationsController,
    // Phase 4-B: /api/payments/{initiate,confirm}-{crypto,bank,cash}
    PaymentChannelController,
    // Phase 4-C: /api/pending-settlements/{senior,drop,tov,:id/settle-*}
    PendingSettlementController,
  ],
  exports: [TransactionsService, BalanceService, PaymentChannelService, PendingSettlementService],
})
export class FinanceModule {}
