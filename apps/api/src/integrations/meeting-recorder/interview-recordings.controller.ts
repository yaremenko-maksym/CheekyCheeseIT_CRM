import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import { linkMeetingRecorderRecordingSchema, type SessionUser } from '@crm/shared'

import { CurrentUser } from '../../auth/current-user.decorator'
import { Roles } from '../../common/decorators/roles.decorator'
import { RolesGuard } from '../../common/guards/roles.guard'
import { AdminWriteThrottle } from '../../config/throttle-decorators'
import { MeetingRecorderService } from './meeting-recorder.service'
import { RecordingMediaUploadService } from './media/recording-media-upload.service'

@UseGuards(RolesGuard)
@Controller('interviews')
export class InterviewMeetingRecordingsController {
  constructor(private readonly service: MeetingRecorderService) {}

  @Get(':interviewId/recordings')
  @Roles('ADMIN', 'SENIOR', 'HR')
  @Header('Cache-Control', 'no-store')
  list(@Param('interviewId', ParseUUIDPipe) interviewId: string, @CurrentUser() user: SessionUser) {
    return this.service.listInterviewRecordings(interviewId, user)
  }
}

@UseGuards(RolesGuard)
@Controller('interview-recordings')
export class InterviewRecordingsController {
  constructor(
    private readonly service: MeetingRecorderService,
    private readonly media: RecordingMediaUploadService,
  ) {}

  @Get('unmatched')
  @Roles('ADMIN')
  @Header('Cache-Control', 'no-store')
  listUnmatched() {
    return this.service.listUnmatchedRecordings()
  }

  @Get(':recordingId')
  @Roles('ADMIN', 'SENIOR', 'HR')
  @Header('Cache-Control', 'no-store')
  detail(
    @Param('recordingId', ParseUUIDPipe) recordingId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.getRecordingDetail(recordingId, user)
  }

  @Post(':recordingId/media/:artifactId/playback')
  @Roles('ADMIN', 'SENIOR', 'HR')
  @Header('Cache-Control', 'no-store')
  async mediaPlayback(
    @Param('recordingId', ParseUUIDPipe) recordingId: string,
    @Param('artifactId') artifactId: string,
    @CurrentUser() user: SessionUser,
  ) {
    const recording = await this.service.getRecordingDetail(recordingId, user)
    return this.media.playbackForCrm(
      recording.connectionId,
      recording.externalRecordingId,
      artifactId,
    )
  }

  @Patch(':id/link')
  @Roles('ADMIN')
  @AdminWriteThrottle()
  link(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.linkRecording(id, linkMeetingRecorderRecordingSchema.parse(body), user)
  }
}
