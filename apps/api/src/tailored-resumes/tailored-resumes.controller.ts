import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  jobQueueScopeQuerySchema,
  tailoredEditRequestSchema,
  tailoredGenerateRequestSchema,
  tailoredListQuerySchema,
  tailoredResumeDetailSchema,
  tailoredResumeRowSchema,
  type SessionUser,
} from '@crm/shared'
import type { FastifyReply } from 'fastify'
import { z } from 'zod'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import type { Env } from '../config/env'
import { SensitiveWriteThrottle } from '../config/throttle-decorators'
import { notFound } from '../job-sourcing/queue/senior-eligibility'
import { TailoredResumesService } from './tailored-resumes.service'

const scopeQuerySchema = jobQueueScopeQuerySchema.pick({ teamId: true })
const runAnswerSchema = z.object({ runId: z.string().uuid() })
const renderAnswerSchema = z.object({ renderId: z.string().uuid() })

/**
 * The tailored resume routes under `/job-queue` (tailored-resume spec §9). `RolesGuard` refuses
 * every role outside ADMIN/HR with a 403; the scope and the senior are authorized in the service.
 * Ids are not `ParseUUIDPipe`d: a malformed id is the queue's uniform 404, never a 400. With
 * `TAILORED_RESUME_ENABLED` false every route answers that 404 first, before any parse or query.
 * Both writes are throttled per user (10 per 60 s); the daily cap lives in the service.
 */
@UseGuards(RolesGuard)
@Controller('job-queue')
export class TailoredResumesController {
  // Explicit @Inject: the vitest/esbuild test env emits no `design:paramtypes`.
  constructor(
    @Inject(TailoredResumesService) private readonly service: TailoredResumesService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  private gate(): void {
    if (!this.config.get('TAILORED_RESUME_ENABLED', { infer: true })) throw notFound()
  }

  /** The batch status for up to 100 seniors (D10); read-only. */
  @Get(':id/tailored')
  @Roles('ADMIN', 'HR')
  async list(@Param('id') id: string, @Query() query: unknown, @CurrentUser() user: SessionUser) {
    this.gate()
    const q = tailoredListQuerySchema.parse(query)
    return z.array(tailoredResumeRowSchema).parse(await this.service.list(user, id, q))
  }

  /** Start a generation: 202 with the run (a running one included). */
  @Post(':id/seniors/:seniorId/tailored')
  @Roles('ADMIN', 'HR')
  @HttpCode(202)
  @SensitiveWriteThrottle()
  async generate(
    @Param('id') id: string,
    @Param('seniorId') seniorId: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    this.gate()
    const request = tailoredGenerateRequestSchema.parse(body)
    return runAnswerSchema.parse(await this.service.generate(user, id, seniorId, request))
  }

  /** HR's edit of the published variant: 202 with the re-render it claimed. */
  @Put(':id/seniors/:seniorId/tailored')
  @Roles('ADMIN', 'HR')
  @HttpCode(202)
  @SensitiveWriteThrottle()
  async edit(
    @Param('id') id: string,
    @Param('seniorId') seniorId: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    this.gate()
    const request = tailoredEditRequestSchema.parse(body)
    return renderAnswerSchema.parse(await this.service.edit(user, id, seniorId, request))
  }

  @Get(':id/seniors/:seniorId/tailored')
  @Roles('ADMIN', 'HR')
  async detail(
    @Param('id') id: string,
    @Param('seniorId') seniorId: string,
    @Query() query: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    this.gate()
    const { teamId } = scopeQuerySchema.parse(query)
    return tailoredResumeDetailSchema.parse(await this.service.detail(user, id, seniorId, teamId))
  }

  /** The published PDF; 202 with no body while it cannot be served yet. */
  @Get(':id/seniors/:seniorId/tailored/pdf')
  @Roles('ADMIN', 'HR')
  async pdf(
    @Param('id') id: string,
    @Param('seniorId') seniorId: string,
    @Query() query: unknown,
    @CurrentUser() user: SessionUser,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    this.gate()
    const { teamId } = scopeQuerySchema.parse(query)
    const answer = await this.service.pdf(user, id, seniorId, teamId)
    if (answer.kind === 'PENDING') {
      await reply.status(202).send()
      return
    }
    const { ascii, utf8 } = answer.filename
    await reply
      .header('Content-Type', 'application/pdf')
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`)
      .send(answer.body)
  }
}
