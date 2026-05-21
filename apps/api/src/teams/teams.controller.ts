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
  type SessionUser,
  updateTeamSchema,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { TeamAuditLogService } from './team-audit-log.service'
import { TeamsService } from './teams.service'

@Controller('teams')
@UseGuards(JwtAuthGuard)
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
    return this.teamsService.findAll(user, { archived: archivedParam === 'true' })
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
    const { name, telegram, notes } = updateTeamSchema.parse(body)
    return this.teamsService.update(id, name, telegram, notes, user)
  }

  @Delete(':id')
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.teamsService.archive(id, user)
  }

  @Post(':id/unarchive')
  unarchive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.teamsService.unarchive(id, user)
  }

  @Get(':id/archive-impact')
  archiveImpact(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.teamsService.getArchiveImpact(id, user)
  }

  @Get(':id/audit-log')
  async auditLog(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
    @Query('page') pageParam?: string,
    @Query('limit') limitParam?: string,
  ) {
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
}
