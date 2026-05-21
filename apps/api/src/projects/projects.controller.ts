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
  addProjectMemberSchema,
  createProjectSchema,
  type SessionUser,
  updateProjectSchema,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { ProjectAuditLogService } from './project-audit-log.service'
import { ProjectsService } from './projects.service'

// Class-level RolesGuard mirrors UsersController for defense-in-depth:
// inline role checks remain in ProjectsService, and the guard rejects
// disallowed roles before the handler runs. Endpoints without @Roles(...)
// are open to any authenticated user (RolesGuard passes when ROLES_KEY is empty).
@Controller('projects')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly projectAuditLogService: ProjectAuditLogService,
  ) {}

  @Get()
  findAll(@CurrentUser() user: SessionUser, @Query('archived') archivedParam?: string) {
    return this.projectsService.findAll(user, { archived: archivedParam === 'true' })
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.projectsService.findOne(id, user)
  }

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = createProjectSchema.parse(body)
    return this.projectsService.create(data, user)
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const data = updateProjectSchema.parse(body)
    return this.projectsService.update(id, data, user)
  }

  @Delete(':id')
  @Roles('ADMIN')
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.projectsService.archive(id, user)
  }

  @Post(':id/unarchive')
  @Roles('ADMIN')
  unarchive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
    @Query('cascade') cascadeParam?: string,
  ) {
    return this.projectsService.unarchive(id, user, cascadeParam === 'true')
  }

  @Get(':id/archive-impact')
  @Roles('ADMIN')
  archiveImpact(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.projectsService.getArchiveImpact(id, user)
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
    const { entries, total } = await this.projectAuditLogService.list(id, page, limit)
    return { entries, total, page, limit }
  }

  @Post(':id/members')
  addMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const { userId } = addProjectMemberSchema.parse(body)
    return this.projectsService.addMember(id, userId, user)
  }

  @Delete(':id/members/:userId')
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.projectsService.removeMember(id, userId, user)
  }
}
