import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  jobQueueCancelSubmissionRequestSchema,
  jobQueueCardResponseSchema,
  jobQueueDismissalResponseSchema,
  jobQueueDismissRequestSchema,
  jobQueueListQuerySchema,
  jobQueueListResponseSchema,
  jobQueueOpenedRequestSchema,
  jobQueueScopeQuerySchema,
  jobQueueSeniorsContinuationSchema,
  jobQueueSourcesContinuationSchema,
  jobQueueSubmissionResponseSchema,
  jobQueueSubmitRequestSchema,
  jobQueueSuppressRequestSchema,
  jobQueueUndoRequestSchema,
  type SessionUser,
} from '@crm/shared'
import { CurrentUser } from '../../auth/current-user.decorator'
import { Roles } from '../../common/decorators/roles.decorator'
import { RolesGuard } from '../../common/guards/roles.guard'
import { RelaxableThrottle } from '../../config/throttle-decorators'
import { JobQueueService } from './job-queue.service'
import { JobQueueActionsService } from './queue-actions.service'

/** The card takes only the scope: a cursor belongs to a continuation, so on the card it is a 400. */
const cardQuerySchema = jobQueueScopeQuerySchema.pick({ teamId: true })

/**
 * Production caps per minute (`RelaxableThrottle`: the window is its default 60 s, and only a
 * non-production `THROTTLE_RELAXED` may raise a cap, never lower it). Reasons: the class comment.
 */
export const JOB_QUEUE_THROTTLE = {
  LIST: 30,
  CARD: 120,
  CONTINUATION: 60,
  SUBMIT: 30,
  CANCEL: 30,
  DISMISS: 60,
  UNDO: 60,
  OPENED: 120,
  SUPPRESS: 30,
} as const

/**
 * r5 Task 6.4 — the `/job-queue` routes over `JobQueueService` (Task 6.2) and
 * `JobQueueActionsService` (Task 6.3).
 *
 * The guard chain: the global `JwtAuthGuard` answers a missing or invalid session with a 401; the
 * `RolesGuard` here refuses every role outside ADMIN / HR with a 403 before a service runs. The
 * scope itself (which team, which opportunity) is resolved per request INSIDE the services
 * (`JobQueueScopeService.resolve`), never here: a NONE scope, a foreign team and a missing
 * opportunity are all the same `JOB_OPPORTUNITY_NOT_FOUND` 404. The `teamId` each request carries
 * (query or body; absent = an ADMIN's studio scope, an HR's first team) is validated by the wire
 * schemas below and authorized by `resolve`.
 *
 * Every id goes through `ParseUUIDPipe`, every query string and body through its `@crm/shared`
 * schema BEFORE a service is called, so bad input is a 400 (`ZodExceptionFilter`), and every answer
 * is parsed again on the way out.
 *
 * THROTTLES, on top of the global `UserAwareThrottlerGuard`, through `RelaxableThrottle` (the
 * project's single throttle mechanism, so CI E2E may relax them outside production). The writes follow the plan's table
 * (submit / cancel / suppress 30, dismiss / undo 60, opened 120 per minute). The reads are chosen
 * here: the LIST is the tightest read, 30 per minute, because a list request without a cursor may
 * PUBLISH a generation (an INSERT of up to `GENERATION_POLICY.maxEntries` ranked entries) when its
 * scope has no live one; infinite scroll pages through the published one by cursor, so 30 pages a
 * minute is far beyond a person reading. The card and its continuations only read, bounded by their
 * previews: 120 per minute for the card (opening one opportunity after another), 60 for the
 * sources and seniors continuations.
 */
@UseGuards(RolesGuard)
@Controller('job-queue')
export class JobQueueController {
  // Explicit @Inject: the vitest/esbuild test env emits no `design:paramtypes`, and the RBAC spec
  // runs THIS controller under Nest's DI (job-queue-rbac.integration.spec.ts).
  constructor(
    @Inject(JobQueueService) private readonly queue: JobQueueService,
    @Inject(JobQueueActionsService) private readonly actions: JobQueueActionsService,
  ) {}

  @Get()
  @Roles('ADMIN', 'HR')
  @RelaxableThrottle(JOB_QUEUE_THROTTLE.LIST)
  async list(@Query() query: unknown, @CurrentUser() user: SessionUser) {
    const parsed = jobQueueListQuerySchema.parse(query)
    return jobQueueListResponseSchema.parse(await this.queue.list(user, parsed))
  }

  @Get(':id')
  @Roles('ADMIN', 'HR')
  @RelaxableThrottle(JOB_QUEUE_THROTTLE.CARD)
  async card(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const parsed = cardQuerySchema.parse(query)
    return jobQueueCardResponseSchema.parse(await this.queue.card(user, id, parsed))
  }

  @Get(':id/sources')
  @Roles('ADMIN', 'HR')
  @RelaxableThrottle(JOB_QUEUE_THROTTLE.CONTINUATION)
  async sources(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const parsed = jobQueueScopeQuerySchema.parse(query)
    return jobQueueSourcesContinuationSchema.parse(await this.queue.sources(user, id, parsed))
  }

  @Get(':id/seniors')
  @Roles('ADMIN', 'HR')
  @RelaxableThrottle(JOB_QUEUE_THROTTLE.CONTINUATION)
  async seniors(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const parsed = jobQueueScopeQuerySchema.parse(query)
    return jobQueueSeniorsContinuationSchema.parse(await this.queue.seniors(user, id, parsed))
  }

  /** «Записати подачу»: records one senior as submitted. It sends nothing to anyone. */
  @Post(':id/submissions')
  @Roles('ADMIN', 'HR')
  @RelaxableThrottle(JOB_QUEUE_THROTTLE.SUBMIT)
  async submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const request = jobQueueSubmitRequestSchema.parse(body)
    return jobQueueSubmissionResponseSchema.parse(await this.actions.submit(user, id, request))
  }

  @Post(':id/submissions/:submissionId/cancel')
  @Roles('ADMIN', 'HR')
  @RelaxableThrottle(JOB_QUEUE_THROTTLE.CANCEL)
  @HttpCode(200)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const request = jobQueueCancelSubmissionRequestSchema.parse(body)
    return jobQueueSubmissionResponseSchema.parse(
      await this.actions.cancelSubmission(user, id, submissionId, request),
    )
  }

  @Post(':id/dismiss')
  @Roles('ADMIN', 'HR')
  @RelaxableThrottle(JOB_QUEUE_THROTTLE.DISMISS)
  @HttpCode(200)
  async dismiss(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const request = jobQueueDismissRequestSchema.parse(body)
    return jobQueueDismissalResponseSchema.parse(await this.actions.dismiss(user, id, request))
  }

  @Post(':id/undo')
  @Roles('ADMIN', 'HR')
  @RelaxableThrottle(JOB_QUEUE_THROTTLE.UNDO)
  @HttpCode(200)
  async undo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const request = jobQueueUndoRequestSchema.parse(body)
    return jobQueueDismissalResponseSchema.parse(await this.actions.undo(user, id, request))
  }

  /** Click telemetry: 204, and the client never waits on it to navigate. */
  @Post(':id/opened')
  @Roles('ADMIN', 'HR')
  @RelaxableThrottle(JOB_QUEUE_THROTTLE.OPENED)
  @HttpCode(204)
  async opened(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    const request = jobQueueOpenedRequestSchema.parse(body)
    await this.actions.opened(user, id, request)
  }

  /** ADMIN only: takes the opportunity down for every team scope (`visibleOpportunityPredicate`). */
  @Post(':id/suppress')
  @Roles('ADMIN')
  @RelaxableThrottle(JOB_QUEUE_THROTTLE.SUPPRESS)
  @HttpCode(204)
  async suppress(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    const request = jobQueueSuppressRequestSchema.parse(body)
    await this.actions.suppress(user, id, request)
  }
}
