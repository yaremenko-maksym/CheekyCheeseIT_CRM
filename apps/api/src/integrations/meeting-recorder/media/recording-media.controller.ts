import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'

import { Public } from '../../../auth/public.decorator'
import { RelaxableThrottle } from '../../../config/throttle-decorators'
import {
  RecordingMediaAuthenticationGuard,
  RecordingMediaConnectionThrottlerGuard,
} from './recording-media-guards'
import { RecordingMediaUploadService } from './recording-media-upload.service'

/** Private extension control-plane API; the bearer token selects the connection. */
@Public()
@UseGuards(RecordingMediaAuthenticationGuard, RecordingMediaConnectionThrottlerGuard)
@Controller('integrations/meeting-recorder/media/v1')
export class RecordingMediaController {
  constructor(private readonly uploads: RecordingMediaUploadService) {}

  @Post('uploads')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RelaxableThrottle(600, 60_000)
  async create(@Req() req: { mediaConnectionId: string }, @Body() body: unknown) {
    return this.uploads.create(req.mediaConnectionId, body)
  }

  @Get('uploads/:uploadId')
  @Header('Cache-Control', 'no-store')
  @RelaxableThrottle(600, 60_000)
  async status(@Req() req: { mediaConnectionId: string }, @Param('uploadId') uploadId: string) {
    return this.uploads.status(req.mediaConnectionId, uploadId)
  }

  @Post('uploads/:uploadId/parts/:partNumber')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RelaxableThrottle(600, 60_000)
  async part(
    @Req() req: { mediaConnectionId: string },
    @Param('uploadId') uploadId: string,
    @Param('partNumber') partNumber: string,
  ) {
    return this.uploads.signPart(req.mediaConnectionId, uploadId, Number(partNumber))
  }

  @Post('uploads/:uploadId/complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RelaxableThrottle(600, 60_000)
  async complete(
    @Req() req: { mediaConnectionId: string },
    @Param('uploadId') uploadId: string,
    @Body() body: unknown,
  ) {
    return this.uploads.complete(req.mediaConnectionId, uploadId, body)
  }

  @Post('artifacts/:artifactId/playback')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RelaxableThrottle(600, 60_000)
  async playback(
    @Req() req: { mediaConnectionId: string },
    @Param('artifactId') artifactId: string,
  ) {
    return this.uploads.playback(req.mediaConnectionId, artifactId)
  }
}
