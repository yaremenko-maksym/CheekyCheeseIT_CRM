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
  changePersonalEmailSchema,
  changeRequisitesSchema,
  changeRoleSchema,
  changeSalarySchema,
  createDropSchema,
  createUserSchema,
  paymentRequisitesSchema,
  rejectPendingShareSchema,
  rejoinTeamSchema,
  setNoteSchema,
  updateProfileSchema,
  type SessionUser,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { AdminWriteThrottle } from '../config/throttle-decorators'
import { Roles } from '../common/decorators/roles.decorator'
import { AuditLog } from '../common/decorators/audit-log.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { AuditInterceptor } from '../common/interceptors/audit.interceptor'
import { AuditLogService } from './audit-log.service'
import { PersonalEmailInviteMailerService } from './personal-email-invite-mailer.service'
import { UsersAccessService } from './users-access.service'
import { UsersService } from './users.service'
import { TransactionsService } from '../finance/transactions.service'

// JwtAuthGuard runs globally (AppModule APP_GUARD); RolesGuard remains
// controller-level because it depends on `req.user.role`.
@Controller('users')
@UseGuards(RolesGuard)
@UseInterceptors(AuditInterceptor)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly auditLogService: AuditLogService,
    private readonly accessService: UsersAccessService,
    private readonly inviteMailer: PersonalEmailInviteMailerService,
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
    //
    // task-accountant-create-transaction: ACCOUNTANT now has create-parity with
    // ADMIN on the finance page. CreateTransactionDialog needs the directory for
    // the admin set — SALARY receiver picker, ADMIN_TRANSFER party picker, and
    // identifying admin-owned projects for ACCOUNTANT-registered ADMIN_INCOME.
    // The list projection (UserListItem) excludes PII / finance columns
    // (legalFullName, bankUah*, wallet*, paymentMethod, monthlySalary,
    // adminNote — see USER_LIST_PROJECTION in users.service.ts); the accountant
    // already has company-wide finance read access, so surfacing the directory
    // is consistent with the role. ACCOUNTANT gets the SAME listing as ADMIN
    // (incl. admins — required to pick transfer parties / admin owners).
    if (
      currentUser.role !== 'ADMIN' &&
      currentUser.role !== 'HR' &&
      currentUser.role !== 'ACCOUNTANT'
    )
      throw new ForbiddenException()
    // round 7 (ut-44): tri-state filter — 'true' = archived only, 'all' = both,
    // anything else (including missing) = active only. Boolean kept for legacy
    // E2E + clients still expecting only `true`/absent.
    const archived: boolean | 'all' = archivedParam === 'all' ? 'all' : archivedParam === 'true'
    return currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT'
      ? this.usersService.findAllIncludingAdmin({ archived })
      : this.usersService.findAll({ archived })
  }

  @Post()
  @Roles('ADMIN', 'HR')
  // security-review PR #623 (SR-M-5, MED): a 409 here confirms an email is
  // already registered — including as someone's PERSONAL address, which the
  // caller (HR included) has no read access to otherwise. Uniqueness itself
  // cannot be relaxed (that reopens SR-H-1's one-address-two-accounts hole),
  // so this throttles the only remaining lever: how many probes per minute
  // an HR/ADMIN session can burn turning this into an enumeration oracle.
  @AdminWriteThrottle()
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
    // MED (security-audit authz-hardening): an HR actor's ONLY established
    // provisioning ability is team/index.tsx's HrCreateSeniorDialog, which
    // deliberately exposes seniorSharePercent (and only that field) to HR.
    // Every other finance/PII field below was previously forwarded verbatim
    // from the raw request body — a rogue/compromised HR account could set
    // its OWN wallet, a 100% share, an inflated salary, or a spoofed
    // legalFullName on the account it is provisioning. For an HR actor those
    // fields are forced to the server defaults regardless of what the body
    // contains; ADMIN is unaffected (full control, as before).
    const isHrActor = currentUser.role === 'HR'
    return this.usersService.createUser({
      email: dto.email,
      // §4.4: same posture as legalFullName/wallet*/bankUah* above — an HR
      // actor's provisioning surface is deliberately narrowed to
      // seniorSharePercent only (see the security comment above), so a
      // personal address (PII the invite flow will email) is forced to
      // server-default (unset) for HR, same as everything else in this list.
      personalEmail: isHrActor ? null : (dto.personalEmail ?? null),
      displayName: dto.displayName,
      role: dto.role,
      telegram: dto.telegram ?? null,
      phone: dto.phone ?? null,
      avatarUrl: dto.avatarUrl ?? null,
      techStack: dto.techStack ?? null,
      ...(dto.seniorSharePercent !== undefined && { seniorSharePercent: dto.seniorSharePercent }),
      monthlySalary: isHrActor ? null : (dto.monthlySalary ?? null),
      ...(!isHrActor && dto.salaryCurrency !== undefined && { salaryCurrency: dto.salaryCurrency }),
      hrIds: dto.hrIds ?? [],
      accountantId: dto.accountantId ?? null,
      projectId: dto.projectId ?? null,
      ...(!isHrActor && dto.paymentMethod !== undefined && { paymentMethod: dto.paymentMethod }),
      walletUsdtErc20: isHrActor ? null : (dto.walletUsdtErc20 ?? null),
      walletUsdtLabel: isHrActor ? null : (dto.walletUsdtLabel ?? null),
      bankUahRecipient: isHrActor ? null : (dto.bankUahRecipient ?? null),
      bankUahIban: isHrActor ? null : (dto.bankUahIban ?? null),
      bankUahRnokpp: isHrActor ? null : (dto.bankUahRnokpp ?? null),
      bankUahBankName: isHrActor ? null : (dto.bankUahBankName ?? null),
      ...(dto.teamMode !== undefined && { teamMode: dto.teamMode }),
      ...(dto.dropTeamId !== undefined && { dropTeamId: dto.dropTeamId }),
      ...(!isHrActor && dto.legalFullName !== undefined && { legalFullName: dto.legalFullName }),
      // MED-3 (security-review round 2): lets the service scope
      // teamMode=JOIN_DROP_TEAM to a drop-team the HR actor actually
      // belongs to (see UsersService.createUser's check).
      actorRole: currentUser.role,
      actorId: currentUser.id,
    })
  }

  // ─────────────────── Drop role - phase 1 endpoints ───────────────────

  /**
   * Create a DROP user + drop-team atomically. Mirrors the senior-create
   * dialog shape but with mandatory team section and `dropSharePercent`.
   */
  @Post('drops')
  @Roles('ADMIN')
  // SR-M-5 — same existence-oracle reasoning as createUser above.
  @AdminWriteThrottle()
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
        // Contract data — persist so the drop's MSA contract renders the legal
        // ФИО / registration address the admin typed (previously dropped).
        legalFullName: dto.legalFullName ?? null,
        registrationAddress: dto.registrationAddress ?? null,
        hrIds: dto.hrIds,
        accountantId: dto.accountantId ?? null,
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
    return this.usersService.buildProfileView(viewer, currentUser.id, currentUser.impersonatorId)
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
    return this.usersService.buildProfileView(viewer, id, currentUser.impersonatorId)
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
    // security-review PR #541 follow-up (HIGH): viewer.role threaded through
    // so getTeamMembersForUser can mask JUNIOR identity from a SENIOR viewer
    // (including SENIOR self-view — this is that self-view's data source).
    return this.usersService.getTeamMembersForUser(id, viewer.role)
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
  async changeRole(
    @CurrentUser() currentUser: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const dto = changeRoleSchema.parse(body)
    return this.usersService.changeRole(id, dto.role, currentUser.id)
  }

  @Patch(':id/salary')
  @Roles('ADMIN')
  @AuditLog('salary_change')
  async changeSalary(
    @CurrentUser() currentUser: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const dto = changeSalarySchema.parse(body)
    return this.usersService.changeSalary(
      id,
      compact(dto) as Parameters<typeof this.usersService.changeSalary>[1],
      currentUser.id,
    )
  }

  /**
   * task-pending-share, position 5. The affected SENIOR confirms a proposed
   * change to their OWN base share % (`users.seniorSharePercent`). No
   * `@Roles(...)` — mirrors `ProjectsController.approveDraft`: a caller who
   * was never the subject of a live proposal simply gets 404 from
   * `ApprovalsService` (no live row for them), so a role check would be
   * redundant, not protective.
   *
   * `@AuditLog('salary_change')` (task-648-fix-round-1, SR-M-1): before this
   * PR, `seniorSharePercent` only ever moved via `PATCH /:id` /
   * `PATCH /:id/salary`, both already decorated — this route is a THIRD
   * writer of the same column that had no audit coverage at all. The
   * interceptor reads `targetId` from `params.id`, present here.
   */
  @Post(':id/senior-share/approve')
  @AuditLog('salary_change')
  approveSeniorShareChange(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() currentUser: SessionUser,
  ) {
    return this.usersService.approveSeniorShareChange(id, currentUser)
  }

  /**
   * task-pending-share, design spec §3 decision 3 — rejection requires a
   * reason. Same no-`@Roles` reasoning as the approve endpoint above.
   * `@AuditLog('salary_change')` — SR-M-1, same reasoning as approve above.
   */
  @Post(':id/senior-share/reject')
  @AuditLog('salary_change')
  rejectSeniorShareChange(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() currentUser: SessionUser,
  ) {
    const { reason } = rejectPendingShareSchema.parse(body)
    return this.usersService.rejectSeniorShareChange(id, reason, currentUser)
  }

  /**
   * task-648-fix-round-1 (SR-H-1). ADMIN withdraws an open base-share
   * proposal outright. No `@Roles(...)` — the service checks ADMIN
   * explicitly, same as the approve/reject pair above check impersonation.
   *
   * `@AuditLog('salary_change')` (task-648-fix-round-2, SR-M-7 / CR-M-2):
   * withdrawing moves `users.pendingSeniorSharePercent` and used to leave no
   * trace of WHO did it, while both its siblings above were decorated. The
   * interceptor's own before/after diff over the `users` row records
   * `pendingSeniorSharePercent` automatically (it is not in `IGNORE_FIELDS`),
   * so the decorator alone is the whole fix — no hand-rolled `record()` call
   * that could drift from what approve/reject log.
   */
  @Post(':id/senior-share/cancel')
  @AuditLog('salary_change')
  cancelSeniorShareChange(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() currentUser: SessionUser,
  ) {
    return this.usersService.cancelSeniorShareChange(id, currentUser)
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

  /**
   * task-user-emails-invite (spec §5 — "Админ должен уметь выслать
   * приглашение заново"). Regenerates the invite token for the user's
   * EXISTING PERSONAL row and re-sends the email — the recovery path for a
   * typo'd address, a lost email, or a delivery failure logged by
   * `PersonalEmailInviteMailerService`. `UsersService.
   * resendPersonalEmailInvite` throws `BadRequestException` (no PERSONAL row
   * at all) or `ConflictException` (already accepted) — both surface as
   * their standard HTTP status via NestJS's exception filter, no special
   * handling needed here.
   *
   * `@AdminWriteThrottle` — same rate-limit posture as every other admin
   * write on this controller (createUser, setNote, archiveUser, …); this
   * one ALSO triggers a real outbound email per call, which is reason
   * enough on its own even before considering it as a write.
   */
  @Post(':id/personal-email/resend-invite')
  @Roles('ADMIN')
  @AdminWriteThrottle()
  async resendPersonalEmailInvite(
    @CurrentUser() currentUser: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const { rawToken, email, displayName } = await this.usersService.resendPersonalEmailInvite(
      id,
      currentUser.id,
    )
    // copy-review PR #623 (COPY-M-1): report whether the mail actually left
    // this process — the frontend toast must not claim "отправлено" when
    // sendInvite silently no-op'd (missing API key) or exhausted its retries.
    const delivered = await this.inviteMailer.sendInvite({ to: email, displayName, rawToken })
    return { ok: true, delivered }
  }

  /**
   * PATCH /api/users/:id/personal-email — security-review PR #623 round 4,
   * owner decision (see `changePersonalEmailSchema`'s doc, `@crm/shared`):
   * fast, unconditional fix for a mistyped personal address. Deliberately a
   * SEPARATE endpoint from `PATCH /:id` (`updateUser` above) — see that
   * schema's own comment for why this stays out of `adminUpdateUserSchema`.
   *
   * `@AuditLog` is NOT used here — `UsersService.changePersonalEmail`
   * records its own audit entry directly (`personal_email_changed`), for
   * the same reason `resendPersonalEmailInvite` does: the automatic
   * before/after diff `AuditInterceptor` performs compares the `users`
   * TABLE row, which never changes here (only `user_emails` does).
   *
   * SR-L-2 (security-review PR #623 round 5): `@AdminWriteThrottle()`
   * (5/min) was flagged as possibly too tight for this specific endpoint —
   * this is the emergency-revocation path, and if a raced accept forced the
   * admin to retry, the 5/min budget could be exhausted mid-incident.
   * Left unchanged: that concern was downstream of SR-H-5 (`UsersService.
   * acceptPersonalEmailInvite`'s own doc), which removed the race that
   * would have forced a retry in the first place — a correctly-ordered
   * `changePersonalEmail` call now either succeeds outright or blocks
   * briefly on a row lock, never fails and needs re-issuing. 5/min remains
   * generous for a single deliberate admin action.
   */
  @Patch(':id/personal-email')
  @Roles('ADMIN')
  @AdminWriteThrottle()
  async changePersonalEmail(
    @CurrentUser() currentUser: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const dto = changePersonalEmailSchema.parse(body)
    const result = await this.usersService.changePersonalEmail(
      id,
      dto.personalEmail,
      currentUser.id,
    )
    if (!result) return { ok: true, delivered: null }
    const delivered = await this.inviteMailer.sendInvite({
      to: result.email,
      displayName: result.displayName,
      rawToken: result.rawToken,
    })
    return { ok: true, delivered }
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
  async archiveImpact(
    @CurrentUser() currentUser: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.usersService.getArchiveImpact(id, currentUser)
  }

  /**
   * GET /api/users/me/salary-meta — self-only salary metadata for JUNIOR hub.
   *
   * Returns current monthly salary, currency, and the date it was last changed
   * (from user_audit_log where changes contains 'monthlySalary' key).
   * No role restriction — any authenticated user can query their own data.
   * Self-only by construction: userId from JWT, no param accepted.
   *
   * AC3/4: salary block in JUNIOR hub.
   */
  @Get('me/salary-meta')
  async getSalaryMeta(@CurrentUser() currentUser: SessionUser) {
    return this.usersService.getSalaryMeta(currentUser.id)
  }
}
