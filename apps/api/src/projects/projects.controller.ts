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
  rejectProjectSchema,
  type SessionUser,
  updateProjectSchema,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { ProjectAuditLogService } from './project-audit-log.service'
import { ProjectsService } from './projects.service'

// JwtAuthGuard runs globally (AppModule APP_GUARD); RolesGuard remains
// controller-level because it depends on `req.user.role`. Endpoints without
// @Roles(...) are open to any authenticated user (RolesGuard passes when
// ROLES_KEY is empty).
@Controller('projects')
@UseGuards(RolesGuard)
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly projectAuditLogService: ProjectAuditLogService,
  ) {}

  @Get()
  findAll(@CurrentUser() user: SessionUser, @Query('archived') archivedParam?: string) {
    // round 7 (ut-44): tri-state filter — 'true' / 'all' / default ('active').
    const archived: boolean | 'all' = archivedParam === 'all' ? 'all' : archivedParam === 'true'
    return this.projectsService.findAll(user, { archived })
  }

  // Drop role - phase 2 (task-drop-2-backend). Self-only DROP project feed.
  // GET /api/projects/drop/me — DROP role ONLY (service throws 403 for every
  // other role). Returns the drop's own active drop-projects enriched with
  // incomesCount + real seniorDisplayName + active|closed status.
  //
  // ROUTE-ORDERING (CRITICAL): this STATIC `drop/me` literal MUST be declared
  // BEFORE `@Get(':id')` below — Fastify/find-my-way would otherwise route
  // `drop` into the `:id` param (and the ParseUUIDPipe would 400 on the
  // non-UUID literal). Declaring it first makes the static segment win.
  @Get('drop/me')
  findDropOwnProjects(@CurrentUser() user: SessionUser) {
    return this.projectsService.findDropOwnProjects(user)
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

  /**
   * task-project-draft-status, item 4. The invited approver (senior or
   * drop) confirms a still-DRAFT project. No `@Roles(...)` — any
   * authenticated role may call this; `ProjectsService.approveDraft` /
   * `ApprovalsService.approveInTx` reject a non-invited caller with 404
   * (no live approval row for them), same as `assertAccess`'s own
   * existence-oracle reasoning.
   */
  @Post(':id/approve')
  approveDraft(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.projectsService.approveDraft(id, user)
  }

  /**
   * task-project-draft-status, item 4 + design spec §3 decision 3.
   * Rejection requires a reason — Zod-validated here, DB-enforced in
   * `approvals` (the CHECK constraint is the backstop, this is shift-left).
   */
  @Post(':id/reject')
  rejectDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const { reason } = rejectProjectSchema.parse(body)
    return this.projectsService.rejectDraft(id, reason, user)
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

  /**
   * GET /api/projects/:id/hr-contact
   *
   * Allowlist HR contact for a project — JUNIOR-facing surface.
   * Returns { displayName, telegram, phone } or null fields when no HR assigned.
   * Access: ADMIN / active JUNIOR member / HR of project's team.
   * Others: 403.
   */
  @Get(':id/hr-contact')
  getHrContact(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.projectsService.getHrContact(id, user)
  }
}
