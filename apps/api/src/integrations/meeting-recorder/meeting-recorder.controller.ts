import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { MEETING_RECORDER_TEST_EVENT_TYPE } from '@crm/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  createMeetingRecorderConnectionSchema,
  meetingRecorderWebhookEventSchema,
  setMeetingRecorderSecretSchema,
  updateMeetingRecorderConnectionSchema,
  type SessionUser,
} from '@crm/shared'

import { CurrentUser } from '../../auth/current-user.decorator'
import { Public } from '../../auth/public.decorator'
import { Roles } from '../../common/decorators/roles.decorator'
import { RolesGuard } from '../../common/guards/roles.guard'
import { AdminWriteThrottle, RelaxableThrottle } from '../../config/throttle-decorators'
import { meetingRecorderWebhookError } from './meeting-recorder-errors'
import { isMeetingRecorderConnectionId } from './meeting-recorder-webhook-auth-hook'
import { isMeetingRecorderCloudEventsContentType } from './meeting-recorder-webhook-parser'
import {
  MeetingRecorderWebhookVerifier,
  type MeetingRecorderWebhookHeaders,
} from './meeting-recorder-webhook-verifier'
import { MeetingRecorderService } from './meeting-recorder.service'
import { RecordingMediaAuthService } from './media/recording-media-auth.service'
import { RecordingMediaStorageService } from './media/recording-media-storage.service'
import type { Env } from '../../config/env'

export const MEETING_RECORDER_WEBHOOK_LIMIT = 120
const MEETING_RECORDER_WEBHOOK_TTL_MS = 60_000

function getWebhookHeaders(request: FastifyRequest): MeetingRecorderWebhookHeaders | null {
  const id = request.headers['webhook-id']
  const timestamp = request.headers['webhook-timestamp']
  const signature = request.headers['webhook-signature']
  if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') {
    return null
  }
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': signature,
  }
}

@Controller('integrations/meeting-recorder')
export class MeetingRecorderWebhookController {
  constructor(
    private readonly service: MeetingRecorderService,
    private readonly verifier: MeetingRecorderWebhookVerifier,
    private readonly mediaAuth: RecordingMediaAuthService,
    private readonly storage: RecordingMediaStorageService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post(':connectionId/webhook')
  @Public()
  @RelaxableThrottle(MEETING_RECORDER_WEBHOOK_LIMIT, MEETING_RECORDER_WEBHOOK_TTL_MS)
  async receiveWebhook(
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    if (!isMeetingRecorderConnectionId(connectionId)) {
      throw meetingRecorderWebhookError(
        'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
        HttpStatus.UNAUTHORIZED,
      )
    }

    if (
      !isMeetingRecorderCloudEventsContentType(request.headers['content-type']) ||
      typeof body !== 'string'
    ) {
      throw meetingRecorderWebhookError(
        'MEETING_RECORDER_CONTENT_TYPE_UNSUPPORTED',
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      )
    }

    const headers = getWebhookHeaders(request)
    if (!headers) {
      throw meetingRecorderWebhookError(
        'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
        HttpStatus.UNAUTHORIZED,
      )
    }

    const authentication = await this.service.getWebhookAuthentication(connectionId)
    if (!this.verifier.verify(body, headers, authentication.secret)) {
      throw meetingRecorderWebhookError(
        'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
        HttpStatus.UNAUTHORIZED,
      )
    }

    let decoded: unknown
    try {
      decoded = JSON.parse(body) as unknown
    } catch /* Stryker disable next-line BlockStatement: an empty catch leaves decoded undefined, and the immediately following schema validation returns the same 422 MEETING_RECORDER_EVENT_INVALID response by design */ {
      throw meetingRecorderWebhookError(
        'MEETING_RECORDER_EVENT_INVALID',
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    const parsed = meetingRecorderWebhookEventSchema.safeParse(decoded)
    if (!parsed.success || parsed.data.id !== headers['webhook-id']) {
      throw meetingRecorderWebhookError(
        'MEETING_RECORDER_EVENT_INVALID',
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    await this.service.ingestWebhookEvent(
      connectionId,
      parsed.data,
      authentication.signingSecretCiphertext,
    )

    reply.header('Cache-Control', 'no-store')
    if (
      parsed.data.type === MEETING_RECORDER_TEST_EVENT_TYPE &&
      (await this.mediaAuth.isProvisioned(connectionId))
    ) {
      const uploadOrigin = await this.storage.uploadOrigin()
      const frontend = new URL(this.config.get('FRONTEND_URL', { infer: true }))
      if (uploadOrigin && frontend.protocol === 'https:') {
        reply.code(HttpStatus.OK)
        return {
          protocol: 'io.github.kstroevsky.meeting-recorder.service.v1',
          capabilities: {
            events: { version: 1 },
            media: {
              version: 1,
              apiBase: `${frontend.origin}/api/integrations/meeting-recorder/media`,
              upload: { strategy: 'multipart-put-v1', origins: [uploadOrigin] },
              playback: { strategy: 'refreshable-url-v1' },
            },
          },
        }
      }
    }
    reply.code(HttpStatus.NO_CONTENT)
    return undefined
  }
}

@UseGuards(RolesGuard)
@Roles('ADMIN')
@Controller('integrations/meeting-recorder/connections')
export class MeetingRecorderAdminController {
  constructor(
    private readonly service: MeetingRecorderService,
    private readonly mediaAuth: RecordingMediaAuthService,
  ) {}

  @Get()
  listConnections() {
    return this.service.listConnections()
  }

  @Post()
  @AdminWriteThrottle()
  createConnection(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.service.createConnection(createMeetingRecorderConnectionSchema.parse(body), user.id)
  }

  @Patch(':id')
  @AdminWriteThrottle()
  updateConnection(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.updateConnection(
      id,
      updateMeetingRecorderConnectionSchema.parse(body),
      user.id,
    )
  }

  @Put(':id/secret')
  @AdminWriteThrottle()
  setSecret(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.setConnectionSecret(id, setMeetingRecorderSecretSchema.parse(body), user.id)
  }

  @Post(':id/reset-pairing')
  @AdminWriteThrottle()
  resetPairing(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.service.resetPairing(id, user.id)
  }

  @Put(':id/token')
  @AdminWriteThrottle()
  @Header('Cache-Control', 'no-store')
  replaceMediaToken(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.mediaAuth.replaceToken(id, user.id)
  }
}
