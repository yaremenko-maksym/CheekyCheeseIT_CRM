import { Module, forwardRef } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { EtherscanService } from './etherscan.service'
import { NbuCurrencyService } from './nbu-currency.service'
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
  ],
  providers: [TransactionsService, EtherscanService, SalaryCronService, NbuCurrencyService],
  controllers: [
    TransactionsController,
    PayoutRequestsController,
    FinanceSummaryController,
    ProjectFinanceSettingsController,
  ],
  exports: [TransactionsService],
})
export class FinanceModule {}
