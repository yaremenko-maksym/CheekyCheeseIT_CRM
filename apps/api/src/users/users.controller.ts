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
  UseInterceptors,
  Optional,
} from '@nestjs/common'

/** Strip keys whose value is `undefined` so exactOptionalPropertyTypes is satisfied. */
 
function compact<T>(obj: T): T {
  return Object.fromEntries(Object.entries(obj as any).filter(([, v]) => v !== undefined)) as T
}
import {
  adminUpdateUserSchema,
  changeRequisitesSchema,
  changeRoleSchema,
  changeSalarySchema,
  createDropSchema,
  createUserSchema,
  paymentRequisitesSchema,
  rejoinTeamSchema,
  setNoteSchema,
  updateProfileSchema,
  type SessionUser,
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
  async findAll(
    @CurrentUser() currentUser: SessionUser,
    @Query('archived') archivedParam?: string,
  ) {
    // Drop role - phase 1 (AC3, security): DROP must not enumerate users.
    // ADMIN/HR are the only callers that need the global directory listing —
    // every other role (including DROP) is rejected. /me, /:id (single
    // profile lookup) and /me/* endpoints remain available since they're
    // self-only or used by the existing profile view.
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') throw new ForbiddenException()
    // round 7 (ut-44): tri-state filter — 'true' = archived only, 'all' = both,
    // anything else (including missing) = active only. Boolean kept for legacy
    // E2E + clients still expecting only `true`/absent.
    const archived: boolean | 'all' = archivedParam === 'all' ? 'all' : archivedParam === 'true'
    return currentUser.role === 'ADMIN'
      ? this.usersService.findAllIncludingAdmin({ archived })
      : this.usersService.findAll({ archived })
  }

  @Post()
  @Roles('ADMIN', 'HR')
  async createUser(@CurrentUser() currentUser: SessionUser, @Body() body: unknown) {
    const dto = createUserSchema.parse(body)
    // ut-12: ADMIN creation is fixed-pool — block at the HTTP boundary too.
    // Service has its own guard, but failing early avoids the email uniqueness
    // round-trip and surfaces a 403 instead of a 409 if the email collides.
    if (dto.role === 'ADMIN') {
      throw new ForbiddenException('Создание ADMIN запрещено — пул фиксирован')
    }
    // Drop role - phase 1: DROP creation goes through POST /api/users/drops.
    if (dto.role === 'DROP') {
      throw new ForbiddenException('Создание DROP — через POST /api/users/drops')
    }
    if (currentUser.role === 'HR' && dto.role !== 'SENIOR') {
      throw new ForbiddenException('HR может создавать только синьоров')
    }
    return this.usersService.createUser({
      email: dto.email,
      displayName: dto.displayName,
      role: dto.role,
      telegram: dto.telegram ?? null,
      phone: dto.phone ?? null,
      avatarUrl: dto.avatarUrl ?? null,
      techStack: dto.techStack ?? null,
      ...(dto.seniorSharePercent !== undefined && { seniorSharePercent: dto.seniorSharePercent }),
      monthlySalary: dto.monthlySalary ?? null,
      ...(dto.salaryCurrency !== undefined && { salaryCurrency: dto.salaryCurrency }),
      hrIds: dto.hrIds ?? [],
      accountantId: dto.accountantId ?? null,
      projectId: dto.projectId ?? null,
      ...(dto.paymentMethod !== undefined && { paymentMethod: dto.paymentMethod }),
      walletUsdtErc20: dto.walletUsdtErc20 ?? null,
      walletUsdtLabel: dto.walletUsdtLabel ?? null,
      bankUahRecipient: dto.bankUahRecipient ?? null,
      bankUahIban: dto.bankUahIban ?? null,
      bankUahRnokpp: dto.bankUahRnokpp ?? null,
      bankUahBankName: dto.bankUahBankName ?? null,
      ...(dto.teamMode !== undefined && { teamMode: dto.teamMode }),
      ...(dto.dropTeamId !== undefined && { dropTeamId: dto.dropTeamId }),
    })
  }

  // ─────────────────── Drop role - phase 1 endpoints ───────────────────

  /**
   * Create a DROP user + drop-team atomically. Mirrors the senior-create
   * dialog shape but with mandatory team section and `dropSharePercent`.
   */
  @Post('drops')
  @Roles('ADMIN')
  async createDrop(@CurrentUser() currentUser: SessionUser, @Body() body: unknown) {
    const dto = createDropSchema.parse(body)
    return this.usersService.createDrop(
      {
        email: dto.email,
        displayName: dto.displayName,
        telegram: dto.telegram ?? null,
        phone: dto.phone ?? null,
        avatarUrl: dto.avatarUrl ?? null,
        techStack: dto.techStack ?? null,
        ...(dto.dropSharePercent !== undefined && { dropSharePercent: dto.dropSharePercent }),
        paymentMethod: dto.paymentMethod,
        walletUsdtErc20: dto.walletUsdtErc20 ?? null,
        walletUsdtLabel: dto.walletUsdtLabel ?? null,
        bankUahRecipient: dto.bankUahRecipient ?? null,
        bankUahIban: dto.bankUahIban ?? null,
        bankUahRnokpp: dto.bankUahRnokpp ?? null,
        bankUahBankName: dto.bankUahBankName ?? null,
        hrIds: dto.hrIds,
        accountantId: dto.accountantId,
        telegramChannel: dto.telegramChannel ?? null,
      },
      currentUser,
    )
  }

  /**
   * Archive a DROP user. Cascade: drop-team archived, drop-projects
   * archived, active SENIOR (if any) DETACHED but kept active.
   */
  @Delete('drops/:id')
  @Roles('ADMIN')
  async archiveDrop(
    @CurrentUser() currentUser: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.usersService.archiveDrop(id, currentUser)
  }

  /**
   * Rejoin-team endpoint for a teamless SENIOR. Self-only — caller must
   * be the senior themselves. Returns the new/joined team id.
   */
  @Post('me/rejoin-team')
  async rejoinTeam(@CurrentUser() currentUser: SessionUser, @Body() body: unknown) {
    if (currentUser.role !== 'SENIOR') {
      throw new ForbiddenException('Rejoin-team доступен только для SENIOR')
    }
    const dto = rejoinTeamSchema.parse(body)
    return this.usersService.rejoinTeam(currentUser.id, {
      teamMode: dto.teamMode,
      ...(dto.dropTeamId !== undefined && { dropTeamId: dto.dropTeamId }),
      ...(dto.hrIds !== undefined && { hrIds: dto.hrIds }),
      ...(dto.accountantId !== undefined && { accountantId: dto.accountantId }),
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
    if (
      (currentUser.role === 'SENIOR' || currentUser.role === 'ADMIN') &&
      dto.paymentMethod !== 'USDT_ERC20'
    ) {
      throw new ForbiddenException('Senior/Admin могут использовать только USDT ERC-20')
    }
    return this.usersService.updateRequisites(
      currentUser.id,
      dto as Parameters<typeof this.usersService.updateRequisites>[1],
    )
  }

  @Get(':id')
  async getProfile(
    @CurrentUser() currentUser: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
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
  async updateUser(
    @CurrentUser() currentUser: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const dto = adminUpdateUserSchema.parse(body)
    return this.usersService.adminUpdateUser(
      id,
      compact(dto) as Parameters<typeof this.usersService.adminUpdateUser>[1],
      currentUser.id,
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
    if (
      (target.role === 'SENIOR' || target.role === 'ADMIN') &&
      dto.paymentMethod !== 'USDT_ERC20'
    ) {
      throw new ForbiddenException('Senior/Admin могут использовать только USDT ERC-20')
    }
    return this.usersService.updateRequisites(
      id,
      dto as Parameters<typeof this.usersService.updateRequisites>[1],
    )
  }

  @Patch(':id/note')
  @Roles('ADMIN')
  @AuditLog('note_set')
  async setNote(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const dto = setNoteSchema.parse(body)
    return this.usersService.setAdminNote(id, dto.note)
  }

  @Delete(':id')
  @Roles('ADMIN')
  async archiveUser(
    @CurrentUser() currentUser: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    if (id === currentUser.id) throw new ForbiddenException('Cannot archive yourself')
    return this.usersService.archive(id, currentUser.id)
  }

  @Post(':id/unarchive')
  @Roles('ADMIN')
  async unarchiveUser(
    @CurrentUser() currentUser: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.usersService.unarchive(id, currentUser.id)
  }

  @Get(':id/archive-impact')
  @Roles('ADMIN')
  async archiveImpact(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.getArchiveImpact(id)
  }
}
