import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'

import {
  addTeamMemberSchema,
  createTeamSchema,
  rotateSeniorSchema,
  type SessionUser,
  updateTeamSchema,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { TeamAuditLogService } from './team-audit-log.service'
import { TeamsService } from './teams.service'

// Class-level RolesGuard mirrors UsersController for defense-in-depth:
// inline role checks remain in TeamsService, and the guard rejects
// disallowed roles before the handler runs. Endpoints without @Roles(...)
// are open to any authenticated user (RolesGuard passes when ROLES_KEY is empty).
@Controller('teams')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TeamsController {
  constructor(
    private readonly teamsService: TeamsService,
    private readonly teamAuditLogService: TeamAuditLogService,
  ) {}

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const { name, seniorId, hrIds, accountantId } = createTeamSchema.parse(body)
    return this.teamsService.create(name, seniorId, hrIds, accountantId, user)
  }

  @Get()
  findAll(@CurrentUser() user: SessionUser, @Query('archived') archivedParam?: string) {
    // round 7 (ut-44): tri-state filter — 'true' / 'all' / default ('active').
    const archived: boolean | 'all' = archivedParam === 'all' ? 'all' : archivedParam === 'true'
    return this.teamsService.findAll(user, { archived })
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.teamsService.findOne(id, user)
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const { name, telegram, telegramChannel, notes, seniorSharePercentOverride } =
      updateTeamSchema.parse(body)
    return this.teamsService.update(id, name, telegram, notes, user, telegramChannel, {
      seniorSharePercentOverride,
    })
  }

  @Delete(':id')
  @Roles('ADMIN')
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.teamsService.archive(id, user)
  }

  @Post(':id/unarchive')
  @Roles('ADMIN')
  unarchive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.teamsService.unarchive(id, user)
  }

  @Get(':id/archive-impact')
  @Roles('ADMIN')
  archiveImpact(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.teamsService.getArchiveImpact(id, user)
  }

  @Get(':id/audit-log')
  @Roles('ADMIN')
  async auditLog(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
    @Query('page') pageParam?: string,
    @Query('limit') limitParam?: string,
  ) {
    // Defense-in-depth: keep the inline ADMIN check even though @Roles('ADMIN')
    // already gates the handler — removing/reordering guards must not regress.
    if (user.role !== 'ADMIN') throw new ForbiddenException()
    const page = Math.max(1, parseInt(pageParam ?? '1', 10))
    const limit = Math.min(100, Math.max(1, parseInt(limitParam ?? '20', 10)))
    const { entries, total } = await this.teamAuditLogService.list(id, page, limit)
    return { entries, total, page, limit }
  }

  @Post(':id/members')
  addMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const { userId } = addTeamMemberSchema.parse(body)
    return this.teamsService.addMember(id, userId, user)
  }

  @Delete(':id/members/:userId')
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.teamsService.removeMember(id, userId, user)
  }

  /**
   * Drop role - phase 1 (AC5 frontend). HTTP boundary for the
   * `TeamsService.rotateSenior` primitive — replaces the current active
   * senior of a drop-team with a new SENIOR that has no active team
   * membership. RBAC (ADMIN or HR of this team) is enforced inside the
   * service; we still let RolesGuard pass without `@Roles(...)` so HR
   * (who is "any authenticated user" for guard purposes here) can call
   * this endpoint and have the inline check decide.
   */
  @Post(':id/rotate-senior')
  rotateSenior(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const { newSeniorId } = rotateSeniorSchema.parse(body)
    return this.teamsService.rotateSenior(id, newSeniorId, user)
  }
}
