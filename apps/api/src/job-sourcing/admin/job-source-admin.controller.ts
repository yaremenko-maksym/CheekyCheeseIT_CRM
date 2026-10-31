import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import {
  createJobSourceNoteSchema,
  excludedJobSourceListSchema,
  jobSourceDetailSchema,
  jobSourceOperationalListSchema,
  resetJobSourceFailuresSchema,
  type SessionUser,
} from '@crm/shared'
import { CurrentUser } from '../../auth/current-user.decorator'
import { Roles } from '../../common/decorators/roles.decorator'
import { RolesGuard } from '../../common/guards/roles.guard'
import { JobSourceAdminService } from './job-source-admin.service'

/**
 * ADMIN controls over the run ledger (r5 Task 2.5 T9), under the job-sourcing route.
 *
 * Authentication is the global JwtAuthGuard. `@Roles('ADMIN')` on EACH handler is the role gate,
 * and the service re-checks the role in its body: RolesGuard does nothing on a handler without
 * `@Roles`, so neither layer is trusted alone. Pinned through the real guard chain by
 * job-source-admin-rbac.integration.spec.ts, one request per role.
 *
 * A separate controller rather than two more routes on JobSourcingController, so the existing
 * controller's constructor (and the specs that build it) stay untouched.
 */
@UseGuards(RolesGuard)
@Controller('job-sourcing/admin')
export class JobSourceAdminController {
  // Explicit @Inject: the vitest/esbuild test env emits no `design:paramtypes`.
  constructor(@Inject(JobSourceAdminService) private readonly service: JobSourceAdminService) {}

  /** Sources the ledger is not running, and why. Read only. */
  @Get('sources/excluded')
  @Roles('ADMIN')
  async listExcluded(@CurrentUser() user: SessionUser) {
    return excludedJobSourceListSchema.parse({ items: await this.service.listExcluded(user) })
  }

  /**
   * U7 source page — every source with its current health state, freshness and cadence summary.
   * Static `sources/health` so it never collides with the `sources/:id` detail below. Read only.
   */
  @Get('sources/health')
  @Roles('ADMIN')
  async listSourceHealth(@CurrentUser() user: SessionUser) {
    return jobSourceOperationalListSchema.parse({
      items: await this.service.listSourceHealth(user),
    })
  }

  /** U7 source page — one source's run timeline + health-event log + correlation hints. Read only. */
  @Get('sources/:id')
  @Roles('ADMIN')
  async sourceDetail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return jobSourceDetailSchema.parse(await this.service.sourceDetail(id, user))
  }

  /**
   * U7 source page — append an ADMIN note as an immutable `NOTE` health event. Throttled like the
   * other admin writes: a held-down button must not flood the append-only log.
   */
  @Post('sources/:id/notes')
  @Roles('ADMIN')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(204)
  async addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    const dto = createJobSourceNoteSchema.parse(body)
    await this.service.addNote(id, dto, user)
  }

  /**
   * Reset one source's failure cap, so the next handler may claim it. Throttled like `collect`:
   * a reset re-arms a possibly paid source, and a held-down button must not loop it.
   */
  @Post('sources/:id/reset-failures')
  @Roles('ADMIN')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(204)
  async resetFailures(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    const dto = resetJobSourceFailuresSchema.parse(body)
    await this.service.resetFailures(id, dto, user)
  }
}
