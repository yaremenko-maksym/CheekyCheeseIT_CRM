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
import { RecordingMediaAuthService } from './media/recording-media-auth.service'
import { RecordingMediaStorageService } from './media/recording-media-storage.service'
import { RecordingMediaUploadService } from './media/recording-media-upload.service'
import { RecordingMediaController } from './media/recording-media.controller'
import { RecordingMediaReconciliationService } from './media/recording-media-reconciliation.service'
import {
  RecordingMediaAuthenticationGuard,
  RecordingMediaConnectionThrottlerGuard,
} from './media/recording-media-guards'

@Module({
  imports: [InterviewsModule, ScheduleModule.forRoot()],
  controllers: [
    MeetingRecorderWebhookController,
    MeetingRecorderAdminController,
    InterviewMeetingRecordingsController,
    InterviewRecordingsController,
    RecordingMediaController,
  ],
  providers: [
    MeetingRecorderService,
    MeetingRecorderSecretCryptoService,
    MeetingRecorderWebhookVerifier,
    MeetingRecorderMatcher,
    MeetingRecorderRetentionCronService,
    RecordingMediaAuthService,
    RecordingMediaAuthenticationGuard,
    RecordingMediaConnectionThrottlerGuard,
    RecordingMediaStorageService,
    RecordingMediaUploadService,
    RecordingMediaReconciliationService,
  ],
})
export class MeetingRecorderModule {}
