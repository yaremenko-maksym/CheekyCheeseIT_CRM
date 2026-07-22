/**
 * VacanciesController — /api/vacancies (ADMIN | HR only).
 *
 * Defense-in-depth RBAC: `@UseGuards(RolesGuard)` + `@Roles(...)` gate at the
 * HTTP boundary (403 before the handler runs), AND VacanciesService /
 * ApplicationsService re-check the role — the guarantee survives even if the
 * controller decorator is ever dropped (the #157/#158 lesson referenced
 * across the codebase). JwtAuthGuard runs globally (AppModule APP_GUARD) so
 * authentication is already covered.
 *
 * Explicit @Inject on every dependency so this REAL controller can be
 * instantiated by Nest's DI in the vitest/esbuild test env (no
 * `design:paramtypes` emission there) — same pattern as
 * CompanyAccountController. Lets the RBAC integration spec exercise THIS
 * controller's guards directly, not a sentinel copy.
 *
 * A SEPARATE class from `PublicVacanciesController` — see that file's header
 * for why public + guarded routes are never mixed on one controller.
 */
import {
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
  UseGuards,
} from '@nestjs/common'
import {
  createVacancySchema,
  updateVacancyApplicationSchema,
  updateVacancySchema,
  type SessionUser,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { ApplicationsService } from './applications.service'
import { VacanciesService } from './vacancies.service'

@Controller('vacancies')
@UseGuards(RolesGuard)
export class VacanciesController {
  constructor(
    @Inject(VacanciesService) private readonly vacanciesService: VacanciesService,
    @Inject(ApplicationsService) private readonly applicationsService: ApplicationsService,
  ) {}

  @Get()
  @Roles('ADMIN', 'HR')
  list(@CurrentUser() actor: SessionUser) {
    return this.vacanciesService.listAdmin(actor)
  }

  @Post()
  @Roles('ADMIN', 'HR')
  create(@CurrentUser() actor: SessionUser, @Body() body: unknown) {
    return this.vacanciesService.create(actor, createVacancySchema.parse(body))
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR')
  update(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.vacanciesService.update(actor, id, updateVacancySchema.parse(body))
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() actor: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.vacanciesService.remove(actor, id)
  }

  @Get(':id/applications')
  @Roles('ADMIN', 'HR')
  listApplications(@CurrentUser() actor: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.applicationsService.list(actor, id)
  }

  @Patch(':id/applications/:appId')
  @Roles('ADMIN', 'HR')
  updateApplication(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('appId', ParseUUIDPipe) appId: string,
    @Body() body: unknown,
  ) {
    const { status } = updateVacancyApplicationSchema.parse(body)
    return this.applicationsService.updateStatus(actor, id, appId, status)
  }

  @Delete(':id/applications/:appId')
  @Roles('ADMIN', 'HR')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeApplication(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('appId', ParseUUIDPipe) appId: string,
  ) {
    await this.applicationsService.remove(actor, id, appId)
  }

  @Get(':id/applications/:appId/resume-url')
  @Roles('ADMIN', 'HR')
  getResumeUrl(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('appId', ParseUUIDPipe) appId: string,
  ) {
    return this.applicationsService.getResumeUrl(actor, id, appId)
  }
}
