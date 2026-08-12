import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  ServiceUnavailableException,
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
  type SessionUser,
  updateJobSuggestionStatusSchema,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { JobSourcingService } from './job-sourcing.service'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Job sourcing API — task-job-sourcing-slice1.
 *
 * Authentication comes from the global JwtAuthGuard (AppModule APP_GUARD).
 * `@Roles` + `RolesGuard` is the role-SET gate; the per-senior SCOPE (HR only
 * their teams, SENIOR only themselves) lives in JobSourcingService and is
 * pinned by job-sourcing.integration.spec.ts against a real database —
 * mocked E2E cannot prove a backend guard (a lesson this repo learned three
 * times over).
 *
 * ACCOUNTANT / JUNIOR / DROP are absent from every `@Roles` set: this surface
 * exposes which companies a senior is being pitched to, which is recruiting
 * data none of them have any business seeing.
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

  /** The senior's queue of NEW suggestions, filtered on read. */
  @Get('suggestions')
  @Roles('ADMIN', 'HR', 'SENIOR')
  async listSuggestions(
    @Query('seniorId') seniorId: string | undefined,
    @CurrentUser() user: SessionUser,
  ) {
    this.assertUuidOrUndefined(seniorId, 'seniorId')
    return jobSuggestionListSchema.parse(await this.service.listSuggestions(seniorId, user))
  }

  /** «Откликнулись» / «Не подходит». */
  @Patch('suggestions/:id/status')
  @Roles('ADMIN', 'HR', 'SENIOR')
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const dto = updateJobSuggestionStatusSchema.parse(body)
    return jobSuggestionSchema.parse(await this.service.updateStatus(id, dto, user))
  }

  /** Studio-wide + personal + project-derived exclusions for one senior. */
  @Get('exclusions')
  @Roles('ADMIN', 'HR', 'SENIOR')
  async listExclusions(
    @Query('seniorId') seniorId: string | undefined,
    @CurrentUser() user: SessionUser,
  ) {
    this.assertUuidOrUndefined(seniorId, 'seniorId')
    return jobExclusionListSchema.parse(await this.service.listExclusions(seniorId, user))
  }

  @Post('exclusions')
  @Roles('ADMIN', 'HR', 'SENIOR')
  async createExclusion(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const dto = createJobExclusionSchema.parse(body)
    return jobExclusionSchema.parse(await this.service.createExclusion(dto, user))
  }

  @Delete('exclusions/:id')
  @Roles('ADMIN', 'HR', 'SENIOR')
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
      throw new ServiceUnavailableException(
        `Сбор не удался: ${run.failures.map((f) => `${f.sourceType} — ${f.message}`).join('; ')}`,
      )
    }

    return jobCollectionRunSchema.parse(run)
  }
}
