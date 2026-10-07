import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { lt } from 'drizzle-orm'

import { DatabaseService } from '../../database/database.service'
import { meetingRecorderWebhookReceipts } from '../../database/schema'

export const MEETING_RECORDER_WEBHOOK_RECEIPT_RETENTION_DAYS = 30
const RETENTION_MS = MEETING_RECORDER_WEBHOOK_RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000

@Injectable()
export class MeetingRecorderRetentionCronService {
  private readonly logger = new Logger(MeetingRecorderRetentionCronService.name)

  constructor(private readonly db: DatabaseService) {}

  @Cron('45 3 * * *')
  async handleRetention(): Promise<void> {
    try {
      const deleted = await this.purgeExpiredReceipts()
      this.logger.log(`Meeting Recorder receipt retention: deleted ${deleted} row(s)`)
    } catch (error: unknown) {
      this.logger.error(
        'Meeting Recorder receipt retention cron failed; will retry next cycle',
        error instanceof Error ? error.stack : String(error),
      )
    }
  }

  async purgeExpiredReceipts(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_MS)
    const deleted = await this.db.db
      .delete(meetingRecorderWebhookReceipts)
      .where(lt(meetingRecorderWebhookReceipts.receivedAt, cutoff))
      .returning({ id: meetingRecorderWebhookReceipts.id })
    return deleted.length
  }
}
