import { Module, forwardRef } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
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
  imports: [DatabaseModule, forwardRef(() => AuthModule), ScheduleModule.forRoot()],
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
