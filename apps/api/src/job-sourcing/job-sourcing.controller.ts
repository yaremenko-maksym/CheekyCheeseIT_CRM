import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import {
  createJobExclusionSchema,
  jobCollectionRunSchema,
  jobExclusionListSchema,
  jobExclusionSchema,
  jobSourceListSchema,
  jobSuggestionListSchema,
  jobSuggestionSchema,
  openJobOpportunityResultSchema,
  type SessionUser,
  updateJobSuggestionStatusSchema,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { apiError } from '../common/api-error'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { JobSourcingService } from './job-sourcing.service'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Job sourcing API — task-job-sourcing-slice1.
 *
 * Authentication comes from the global JwtAuthGuard (AppModule APP_GUARD).
 * `@Roles` + `RolesGuard` is the role-SET gate; the per-senior SCOPE (HR only
 * their teams) lives in JobSourcingService and is pinned by
 * job-sourcing.integration.spec.ts against a real database — mocked E2E cannot
 * prove a backend guard (a lesson this repo learned three times over).
 *
 * SENIOR / JUNIOR / DROP are absent from every `@Roles` set: this
 * surface exposes which companies a senior is being pitched to, which is
 * recruiting data none of them have any business seeing.
 *
 * task-sources-07c (owner decision 2026-11-19) removed SENIOR from the six
 * suggestion / opportunity / exclusion handlers below. A senior does not triage
 * vacancies at all — they see the RESULT of HR's queue work as interview cards
 * on their own Interviews page (`interviews.stage = 'SUBMITTED'`). Each of the
 * six service methods ALSO calls `JobSourcingService.assertNotSenior` first, so
 * the refusal survives someone widening a `@Roles` set in a refactor; both
 * layers are pinned separately by job-sourcing-rbac.integration.spec.ts.
 */
@UseGuards(RolesGuard)
@Controller('job-sourcing')
export class JobSourcingController {
  // Explicit @Inject so this REAL controller can be instantiated by Nest's DI in
  // the vitest/esbuild test env (no `design:paramtypes` emission there) — the
  // same reason VacanciesController and CompanyAccountController do it. It lets
  // job-sourcing-rbac.integration.spec.ts exercise THIS controller's guard
  // chain rather than a sentinel copy of it.
  constructor(@Inject(JobSourcingService) private readonly service: JobSourcingService) {}

  private assertUuidOrUndefined(value: string | undefined, field: string): void {
    if (value !== undefined && !UUID_RE.test(value)) {
      throw new BadRequestException(`${field} должен быть корректным UUID`)
    }
  }

  /** The queue of NEW suggestions for one senior, filtered on read. ADMIN / HR only. */
  @Get('suggestions')
  @Roles('ADMIN', 'HR')
  async listSuggestions(
    @Query('seniorId') seniorId: string | undefined,
    @CurrentUser() user: SessionUser,
  ) {
    this.assertUuidOrUndefined(seniorId, 'seniorId')
    return jobSuggestionListSchema.parse(await this.service.listSuggestions(seniorId, user))
  }

  /** «Откликнулись» / «Не подходит». */
  @Patch('suggestions/:id/status')
  @Roles('ADMIN', 'HR')
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const dto = updateJobSuggestionStatusSchema.parse(body)
    return jobSuggestionSchema.parse(await this.service.updateStatus(id, dto, user))
  }

  /**
   * SFS U10 (ADR 6a, step 2 "Want"): open one opportunity. If its ON_DEMAND detail is missing, this
   * enqueues a fetch (a DB write, never an external call; fetch-once). HR/ADMIN only, and the
   * per-opportunity SCOPE (HR only their teams' seniors) is enforced in
   * the service body — pinned by job-sourcing-rbac.integration.spec, a mocked E2E cannot prove it.
   */
  @Post('opportunities/:id/open')
  @Roles('ADMIN', 'HR')
  async openOpportunity(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return openJobOpportunityResultSchema.parse(await this.service.openOpportunity(id, user))
  }

  /** Studio-wide + personal + project-derived exclusions for one senior. */
  @Get('exclusions')
  @Roles('ADMIN', 'HR')
  async listExclusions(
    @Query('seniorId') seniorId: string | undefined,
    @CurrentUser() user: SessionUser,
  ) {
    this.assertUuidOrUndefined(seniorId, 'seniorId')
    return jobExclusionListSchema.parse(await this.service.listExclusions(seniorId, user))
  }

  @Post('exclusions')
  @Roles('ADMIN', 'HR')
  async createExclusion(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const dto = createJobExclusionSchema.parse(body)
    return jobExclusionSchema.parse(await this.service.createExclusion(dto, user))
  }

  @Delete('exclusions/:id')
  @Roles('ADMIN', 'HR')
  @HttpCode(204)
  async deleteExclusion(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.service.deleteExclusion(id, user)
  }

  /**
   * Configured sources with their remaining request budget — ADMIN only.
   *
   * Exists so the remainder is VISIBLE (task-vacancy-matching AC7): a collector
   * that has stopped because its allowance is spent must be distinguishable, on
   * screen, from one that simply found nothing today.
   */
  @Get('sources')
  @Roles('ADMIN')
  async listSources(@CurrentUser() user: SessionUser) {
    // The role is re-checked inside the service (MED-1) — defence in depth, the
    // same shape every other route on this controller already uses.
    return jobSourceListSchema.parse({ items: await this.service.listSources(user) })
  }

  /**
   * Manual collection trigger — ADMIN only. The scheduled run
   * (JobSourcingCronService) is the normal path; this exists so an admin can
   * pull the feed right after adding a source instead of waiting a day.
   *
   * Throttled deliberately (task-vacancy-matching §5): the budget is the real
   * defence, and it counts manual runs the same as scheduled ones, but a button
   * that can be held down is still a way to spend a month's paid quota in a
   * minute of misclicks. The rate limit makes that take as long as it should.
   *
   * Passes `MANUAL`, so this endpoint collects the sources a human is allowed to
   * trigger — including the expensive ones the cron is not allowed to touch.
   */
  @Post('collect')
  @Roles('ADMIN')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async collect(@CurrentUser() user: SessionUser) {
    const run = await this.service.collectAllAsActor(user)

    // Code review round 4: this used to answer `200 []` when the only source
    // was broken — indistinguishable from "no new vacancies today" for the
    // admin who pressed the button. A run in which NOTHING succeeded is a
    // failure and says so with a 503; a partial run returns 200 but carries the
    // `failures` array, so a broken source is never invisible either way.
    if (run.results.length === 0 && run.failures.length > 0) {
      // ADR 2026-11-03 §H.8: when the model stage stopped on the AI limits, the 503 says so with
      // its own static code; any other "nothing succeeded" answers JOB_SOURCING_COLLECTION_FAILED.
      // The per-source causes are already logged by `collectAll`.
      if (run.sourcingNotice === 'AI_LIMITS_EXHAUSTED') {
        throw apiError('JOB_SOURCING_AI_LIMITS_EXHAUSTED', HttpStatus.SERVICE_UNAVAILABLE)
      }
      throw apiError('JOB_SOURCING_COLLECTION_FAILED', HttpStatus.SERVICE_UNAVAILABLE)
    }

    return jobCollectionRunSchema.parse(run)
  }
}
