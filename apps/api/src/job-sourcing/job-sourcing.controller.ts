import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  createJobExclusionSchema,
  jobCollectionResultSchema,
  jobExclusionListSchema,
  jobExclusionSchema,
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
 * pinned by job-sourcing-rbac.integration.spec.ts against a real database —
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
  constructor(private readonly service: JobSourcingService) {}

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
   * Manual collection trigger — ADMIN only. The scheduled run
   * (JobSourcingCronService) is the normal path; this exists so an admin can
   * pull the feed right after adding a source instead of waiting a day.
   */
  @Post('collect')
  @Roles('ADMIN')
  async collect() {
    const results = await this.service.collectAll()
    return results.map((result) => jobCollectionResultSchema.parse(result))
  }
}
