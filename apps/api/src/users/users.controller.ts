import {
  Body, Controller, Delete, ForbiddenException, Get, NotImplementedException, Param, ParseUUIDPipe,
  Patch, Post, Query, UseGuards, UseInterceptors, Optional,
} from '@nestjs/common'

/** Strip keys whose value is `undefined` so exactOptionalPropertyTypes is satisfied. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compact<T>(obj: T): T { return Object.fromEntries(Object.entries(obj as any).filter(([, v]) => v !== undefined)) as T }
import {
  adminUpdateUserSchema, changeRequisitesSchema, changeRoleSchema, changeSalarySchema,
  createUserSchema, paymentRequisitesSchema, projectReassignSchema, setNoteSchema,
  teamMembershipSchema, updateProfileSchema, type SessionUser,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { AuditLog } from '../common/decorators/audit-log.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { AuditInterceptor } from '../common/interceptors/audit.interceptor'
import { AuditLogService } from './audit-log.service'
import { UsersAccessService } from './users-access.service'
import { UsersService } from './users.service'
import { TransactionsService } from '../finance/transactions.service'

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(AuditInterceptor)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly auditLogService: AuditLogService,
    private readonly accessService: UsersAccessService,
    @Optional() private readonly transactionsService?: TransactionsService,
  ) {}

  @Get()
  async findAll(@CurrentUser() currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') throw new ForbiddenException()
    return currentUser.role === 'ADMIN'
      ? this.usersService.findAllIncludingAdmin()
      : this.usersService.findAll()
  }

  @Post()
  @Roles('ADMIN', 'HR')
  async createUser(@CurrentUser() currentUser: SessionUser, @Body() body: unknown) {
    const dto = createUserSchema.parse(body)
    if (currentUser.role === 'HR' && dto.role !== 'SENIOR') {
      throw new ForbiddenException('HR может создавать только синьоров')
    }
    return this.usersService.createUser({
      email: dto.email,
      displayName: dto.displayName,
      role: dto.role,
      telegram: dto.telegram ?? null,
      phone: dto.phone ?? null,
      avatar: dto.avatar ?? null,
      techStack: dto.techStack ?? null,
      ...(dto.seniorSharePercent !== undefined && { seniorSharePercent: dto.seniorSharePercent }),
      monthlySalary: dto.monthlySalary ?? null,
      hrIds: dto.hrIds ?? [],
      accountantId: dto.accountantId ?? null,
      projectId: dto.projectId ?? null,
    })
  }

  // Static named routes MUST come before :id to avoid NestJS matching "me" as an id param
  @Get('me')
  async getMe(@CurrentUser() currentUser: SessionUser) {
    const viewer = await this.usersService.findById(currentUser.id)
    if (!viewer) throw new ForbiddenException()
    return this.usersService.buildProfileView(viewer, currentUser.id)
  }

  @Patch('me')
  @AuditLog('profile_edit')
  async updateMe(@CurrentUser() currentUser: SessionUser, @Body() body: unknown) {
    const dto = updateProfileSchema.parse(body)
    return this.usersService.updateProfile(
      currentUser.id,
      compact(dto) as Parameters<typeof this.usersService.updateProfile>[1],
    )
  }

  @Patch('me/requisites')
  @AuditLog('requisites_edit')
  async updateMeRequisites(@CurrentUser() currentUser: SessionUser, @Body() body: unknown) {
    const dto = paymentRequisitesSchema.parse(body)
    if ((currentUser.role === 'SENIOR' || currentUser.role === 'ADMIN') && dto.paymentMethod !== 'USDT_ERC20') {
      throw new ForbiddenException('Senior/Admin могут использовать только USDT ERC-20')
    }
    return this.usersService.updateRequisites(currentUser.id, dto as Parameters<typeof this.usersService.updateRequisites>[1])
  }

  @Get(':id')
  async getProfile(@CurrentUser() currentUser: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    const viewer = await this.usersService.findById(currentUser.id)
    if (!viewer) throw new ForbiddenException()
    return this.usersService.buildProfileView(viewer, id)
  }

  @Get(':id/team')
  async getUserTeam(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() currentUser: SessionUser,
  ) {
    const viewer = await this.usersService.findById(currentUser.id)
    const target = await this.usersService.findById(id)
    if (!viewer || !target) throw new ForbiddenException()
    const permissions = await this.accessService.getViewPermissions(viewer, target)
    if (!permissions.tabs.includes('team')) throw new ForbiddenException()
    return this.usersService.getTeamMembersForUser(id)
  }

  @Get(':id/audit-log')
  @Roles('ADMIN')
  async getAuditLog(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') pageParam?: string,
    @Query('limit') limitParam?: string,
  ) {
    const page = Math.max(1, parseInt(pageParam ?? '1', 10))
    const limit = Math.min(100, Math.max(1, parseInt(limitParam ?? '20', 10)))
    const { entries, total } = await this.auditLogService.list(id, page, limit)
    return { entries, total, page, limit }
  }

  @Get(':id/transactions')
  @Roles('ADMIN', 'ACCOUNTANT')
  async getUserTransactions(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() currentUser: SessionUser,
  ) {
    // Defense-in-depth: also assert role explicitly here so removing/reordering
    // guards or decorators cannot accidentally expose this endpoint.
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }
    if (!this.transactionsService) return []
    // ADMIN and ACCOUNTANT both see all transactions in TransactionsService.findAll,
    // so we pass the real viewer — no role spoofing.
    return this.transactionsService.findAll(currentUser, { seniorId: id })
  }

  @Patch(':id')
  @Roles('ADMIN')
  @AuditLog('profile_edit')
  async updateUser(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const dto = adminUpdateUserSchema.parse(body)
    return this.usersService.updateProfile(
      id,
      compact(dto) as Parameters<typeof this.usersService.updateProfile>[1],
    )
  }

  @Patch(':id/role')
  @Roles('ADMIN')
  @AuditLog('role_change')
  async changeRole(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const dto = changeRoleSchema.parse(body)
    return this.usersService.changeRole(id, dto.role)
  }

  @Patch(':id/salary')
  @Roles('ADMIN')
  @AuditLog('salary_change')
  async changeSalary(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const dto = changeSalarySchema.parse(body)
    return this.usersService.changeSalary(
      id,
      compact(dto) as Parameters<typeof this.usersService.changeSalary>[1],
    )
  }

  @Patch(':id/requisites')
  @Roles('ADMIN')
  @AuditLog('requisites_edit')
  async changeRequisites(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const dto = changeRequisitesSchema.parse(body)
    const target = await this.usersService.findById(id)
    if (!target) throw new ForbiddenException('User not found')
    if ((target.role === 'SENIOR' || target.role === 'ADMIN') && dto.paymentMethod !== 'USDT_ERC20') {
      throw new ForbiddenException('Senior/Admin могут использовать только USDT ERC-20')
    }
    return this.usersService.updateRequisites(id, dto as Parameters<typeof this.usersService.updateRequisites>[1])
  }

  @Patch(':id/note')
  @Roles('ADMIN')
  @AuditLog('note_set')
  async setNote(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const dto = setNoteSchema.parse(body)
    return this.usersService.setAdminNote(id, dto.note)
  }

  @Post(':id/team-membership')
  @Roles('ADMIN')
  async manageTeam(@Param('id', ParseUUIDPipe) _id: string, @Body() body: unknown) {
    // Parse body to give a clear 400 on malformed payloads even though the
    // endpoint is not implemented yet — keeps API contract honest.
    teamMembershipSchema.parse(body)
    throw new NotImplementedException('Управление командой будет реализовано в следующей итерации')
  }

  @Post(':id/project-reassign')
  @Roles('ADMIN')
  async reassignProject(@Param('id', ParseUUIDPipe) _id: string, @Body() body: unknown) {
    projectReassignSchema.parse(body)
    throw new NotImplementedException('Переназначение проекта будет реализовано в следующей итерации')
  }

  @Delete(':id')
  @Roles('ADMIN')
  @AuditLog('user_archived')
  async archiveUser(@CurrentUser() currentUser: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    if (id === currentUser.id) throw new ForbiddenException('Cannot archive yourself')
    return this.usersService.archive(id)
  }
}
