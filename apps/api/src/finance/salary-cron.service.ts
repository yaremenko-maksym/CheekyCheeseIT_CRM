import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { TransactionsService } from './transactions.service'

@Injectable()
export class SalaryCronService {
  private readonly logger = new Logger(SalaryCronService.name)

  constructor(private readonly txService: TransactionsService) {}

  // Runs at 00:00 on the 1st of every month — creates salaries for the PREVIOUS month
  @Cron('0 0 1 * *')
  async handleMonthlySalaries() {
    const now = new Date()
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const month = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
    this.logger.log(`Creating monthly salary transactions for ${month}`)
    await this.txService.createMonthlySalaries(month)
    this.logger.log(`Monthly salary transactions done for ${month}`)
  }
}
