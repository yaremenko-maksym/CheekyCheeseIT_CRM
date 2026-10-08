import { Body, Controller, Get, Header, Headers, HttpCode, Param, Post } from '@nestjs/common'

import { Public } from '../../../auth/public.decorator'
import { RelaxableThrottle } from '../../../config/throttle-decorators'
import { RecordingMediaAuthService } from './recording-media-auth.service'
import { RecordingMediaUploadService } from './recording-media-upload.service'

/** Private extension control-plane API; the bearer token selects the connection. */
@Public()
@Controller('integrations/meeting-recorder/media/v1')
export class RecordingMediaController {
  constructor(
    private readonly auth: RecordingMediaAuthService,
    private readonly uploads: RecordingMediaUploadService,
  ) {}

  @Post('uploads')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RelaxableThrottle(600, 60_000)
  async create(@Headers('authorization') credential: string | undefined, @Body() body: unknown) {
    return this.uploads.create(await this.auth.authenticate(credential), body)
  }

  @Get('uploads/:uploadId')
  @Header('Cache-Control', 'no-store')
  @RelaxableThrottle(600, 60_000)
  async status(
    @Headers('authorization') credential: string | undefined,
    @Param('uploadId') uploadId: string,
  ) {
    return this.uploads.status(await this.auth.authenticate(credential), uploadId)
  }

  @Post('uploads/:uploadId/parts/:partNumber')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RelaxableThrottle(600, 60_000)
  async part(
    @Headers('authorization') credential: string | undefined,
    @Param('uploadId') uploadId: string,
    @Param('partNumber') partNumber: string,
  ) {
    return this.uploads.signPart(
      await this.auth.authenticate(credential),
      uploadId,
      Number(partNumber),
    )
  }

  @Post('uploads/:uploadId/complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RelaxableThrottle(600, 60_000)
  async complete(
    @Headers('authorization') credential: string | undefined,
    @Param('uploadId') uploadId: string,
    @Body() body: unknown,
  ) {
    return this.uploads.complete(await this.auth.authenticate(credential), uploadId, body)
  }

  @Post('artifacts/:artifactId/playback')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RelaxableThrottle(600, 60_000)
  async playback(
    @Headers('authorization') credential: string | undefined,
    @Param('artifactId') artifactId: string,
  ) {
    return this.uploads.playback(await this.auth.authenticate(credential), artifactId)
  }
}
