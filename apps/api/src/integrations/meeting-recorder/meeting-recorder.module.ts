import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'

import { InterviewsModule } from '../../interviews/interviews.module'
import {
  InterviewMeetingRecordingsController,
  InterviewRecordingsController,
} from './interview-recordings.controller'
import {
  MeetingRecorderAdminController,
  MeetingRecorderWebhookController,
} from './meeting-recorder.controller'
import { MeetingRecorderMatcher } from './meeting-recorder-matcher'
import { MeetingRecorderRetentionCronService } from './meeting-recorder-retention.cron'
import { MeetingRecorderSecretCryptoService } from './meeting-recorder-secret-crypto.service'
import { MeetingRecorderWebhookVerifier } from './meeting-recorder-webhook-verifier'
import { MeetingRecorderService } from './meeting-recorder.service'

@Module({
  imports: [InterviewsModule, ScheduleModule.forRoot()],
  controllers: [
    MeetingRecorderWebhookController,
    MeetingRecorderAdminController,
    InterviewMeetingRecordingsController,
    InterviewRecordingsController,
  ],
  providers: [
    MeetingRecorderService,
    MeetingRecorderSecretCryptoService,
    MeetingRecorderWebhookVerifier,
    MeetingRecorderMatcher,
    MeetingRecorderRetentionCronService,
  ],
})
export class MeetingRecorderModule {}
