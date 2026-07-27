import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common'
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import type { ArchiveImpact, AuditChange, SessionUser } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  documents,
  projectMembers,
  projects,
  teamMembers,
  teams,
  userAuditLog,
  users,
  type User,
} from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { TeamAuditLogService } from '../teams/team-audit-log.service'
import { TeamsService } from '../teams/teams.service'
import { ProjectAuditLogService } from '../projects/project-audit-log.service'
import { TosService } from '../tos/tos.service'
import { AuditLogService, REDACTED_TOKEN } from './audit-log.service'
import { UsersAccessService } from './users-access.service'

export type AppRole = 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP'

export interface TeamMemberPreview {
  id: string
  displayName: string
  role: User['role']
  avatarUrl: string | null
  avatarDocumentId: string | null
}

// Slim list-item projection for GET /api/users. ONLY directory fields the UI
// pickers (CreateTransactionDialog, team/project dropdowns, nav, admin user
// list rows) actually consume — id / displayName / role / contacts / avatar /
// share. Sensitive PII and finance fields are deliberately EXCLUDED from the
// list payload (security data-exposure fix, ревью #222):
//   bankUahIban / bankUahRnokpp (налоговый №) / bankUahRecipient / bankUahBankName,
//   walletUsdtErc20 / walletUsdtLabel, paymentMethod, monthlySalary,
//   registrationAddress (ФОП PII), adminNote, legalFullName.
// Those remain accessible ONLY via the single-resource GET /api/users/:id
// endpoint, where buildProfileView applies RBAC masking per viewer→target.
// `UserListItem` is an explicit Pick (not Omit<User, …>) so adding a new column
// to the schema does NOT silently leak it into the list — and so `tsc` flags any
// consumer that reads a field we deliberately dropped (drives the slim contract).
export type UserListItem = Pick<
  User,
  | 'id'
  | 'email'
  | 'displayName'
  | 'role'
  | 'avatarUrl'
  | 'avatarDocumentId'
  | 'telegram'
  | 'phone'
  | 'techStack'
  | 'seniorSharePercent'
  | 'dropSharePercent'
  | 'salaryCurrency'
  | 'archivedAt'
  | 'createdAt'
  | 'updatedAt'
>
export type UserWithAvailability = UserListItem & { hasActiveProject: boolean }

/**
 * Drizzle select projection for list endpoints (GET /api/users). Mirrors
 * `UserListItem` exactly. PII / finance columns (bankUah*, wallet*,
 * paymentMethod, monthlySalary, registrationAddress, adminNote,
 * legalFullName) are intentionally absent — they are only accessible via
 * GET /api/users/:id through buildProfileView + RBAC masking.
 *
 * `salaryCurrency` / share percents are non-sensitive (no amount, just the
 * unit / split %) and pickers key UI off them, so they stay.
 */
const USER_LIST_PROJECTION = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  role: users.role,
  avatarUrl: users.avatarUrl,
  avatarDocumentId: users.avatarDocumentId,
  telegram: users.telegram,
  phone: users.phone,
  techStack: users.techStack,
  seniorSharePercent: users.seniorSharePercent,
  dropSharePercent: users.dropSharePercent,
  salaryCurrency: users.salaryCurrency,
  archivedAt: users.archivedAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
  // SENSITIVE — intentionally excluded from list (see UserListItem): bankUah*,
  // wallet*, paymentMethod, monthlySalary, registrationAddress,
  // adminNote, legalFullName. Available via GET /api/users/:id only.
} as const

@Injectable()
export class UsersService {
  constructor(
    private db: DatabaseService,
    private accessService: UsersAccessService,
    private auditLogService: AuditLogService,
    private tosService: TosService,
    @Inject(forwardRef(() => TeamAuditLogService))
    private teamAuditLogService: TeamAuditLogService,
    @Inject(forwardRef(() => ProjectAuditLogService))
    private projectAuditLogService: ProjectAuditLogService,
    @Inject(forwardRef(() => TeamsService))
    private teamsService: TeamsService,
  ) {}

  findByEmail(email: string): Promise<User | undefined> {
    return this.db.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .then((rows) => rows[0])
  }

  findById(id: string): Promise<User | undefined> {
    return this.db.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .then((rows) => rows[0])
  }

  async findAll(filter: { archived?: boolean | 'all' } = {}): Promise<UserWithAvailability[]> {
    // round 7 (ut-44): tri-state filter — `'all'` returns both active and
    // archived rows in one query, used by the «Все» tab on /crm/users.
    const archivedFilter =
      filter.archived === 'all'
        ? undefined
        : filter.archived === true
          ? isNotNull(users.archivedAt)
          : isNull(users.archivedAt)
    const where = archivedFilter
      ? and(ne(users.role, 'ADMIN'), archivedFilter)
      : ne(users.role, 'ADMIN')
    // USER_LIST_PROJECTION excludes legalFullName — see module-level constant.
    const allUsers = await this.db.db.select(USER_LIST_PROJECTION).from(users).where(where)
    const activeProjectMemberships = await this.db.db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(isNull(projectMembers.leftAt))
    const busyJuniorIds = new Set(activeProjectMemberships.map((m) => m.userId))
    return allUsers.map((u) => ({
      ...u,
      hasActiveProject: u.role === 'JUNIOR' ? busyJuniorIds.has(u.id) : false,
    }))
  }

  async findAllIncludingAdmin(
    filter: { archived?: boolean | 'all' } = {},
  ): Promise<UserWithAvailability[]> {
    const archivedFilter =
      filter.archived === 'all'
        ? undefined
        : filter.archived === true
          ? isNotNull(users.archivedAt)
          : isNull(users.archivedAt)
    // USER_LIST_PROJECTION excludes legalFullName — see module-level constant.
    const allUsers = archivedFilter
      ? await this.db.db.select(USER_LIST_PROJECTION).from(users).where(archivedFilter)
      : await this.db.db.select(USER_LIST_PROJECTION).from(users)
    const activeProjectMemberships = await this.db.db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(isNull(projectMembers.leftAt))
    const busyJuniorIds = new Set(activeProjectMemberships.map((m) => m.userId))
    return allUsers.map((u) => ({
      ...u,
      hasActiveProject: u.role === 'JUNIOR' ? busyJuniorIds.has(u.id) : false,
    }))
  }

  async getProfile(id: string): Promise<User> {
    const user = await this.findById(id)
    if (!user) throw new NotFoundException('User not found')
    return user
  }

  /**
   * Validate that the supplied `avatarDocumentId` references a document with
   * `category = 'AVATAR'` owned by `ownerId` (or any owner when invoker is
   * ADMIN). Throws `BadRequestException` otherwise so the caller surfaces a
   * 400 with a human-readable message.
   *
   * `null` is treated as a clear-avatar operation and short-circuits.
   */
  private async assertAvatarDocument(
    documentId: string | null | undefined,
    expectedOwnerId: string,
  ): Promise<void> {
    if (documentId === undefined || documentId === null) return
    const row = await this.db.db.query.documents.findFirst({
      where: eq(documents.id, documentId),
    })
    if (!row) throw new BadRequestException('Аватар: документ не найден')
    if (row.category !== 'AVATAR') {
      throw new BadRequestException('Категория документа должна быть AVATAR')
    }
    if (row.ownerId !== expectedOwnerId) {
      throw new BadRequestException('Аватар: документ принадлежит другому пользователю')
    }
    if (row.deletedAt !== null) {
      throw new BadRequestException('Аватар: документ удалён')
    }
  }

  async createUser(data: {
    email: string
    displayName: string
    role: AppRole
    telegram?: string | null
    phone?: string | null
    avatarUrl?: string | null
    techStack?: string[] | null
    seniorSharePercent?: number
    monthlySalary?: number | null
    salaryCurrency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
    hrIds?: string[]
    accountantId?: string | null
    projectId?: string | null
    paymentMethod?: 'USDT_ERC20' | 'BANK_UAH_FOP'
    walletUsdtErc20?: string | null
    walletUsdtLabel?: string | null
    bankUahRecipient?: string | null
    bankUahIban?: string | null
    bankUahRnokpp?: string | null
    bankUahBankName?: string | null
    /**
     * Legal full name (Cyrillic, order: Surname First Patronymic).
     * Used in MSA contract instead of displayName. Optional at creation time.
     */
    legalFullName?: string
    /**
     * Drop role - phase 1: senior-only opt-in. `CREATE_NEW` (default)
     * preserves the legacy auto-team flow. `JOIN_DROP_TEAM` skips auto-team
     * and attaches the new senior to an existing drop-team.
     */
    teamMode?: 'CREATE_NEW' | 'JOIN_DROP_TEAM'
    /** Required when `teamMode='JOIN_DROP_TEAM'`. */
    dropTeamId?: string
    /**
     * MED-3 (security-review round 2, authz-hardening): identity of the
     * caller, used ONLY to scope `teamMode='JOIN_DROP_TEAM'` for an HR actor
     * to a drop-team they actually belong to (see the check below). Optional
     * so every existing unit test that constructs `data` directly (bypassing
     * the controller) keeps working unchanged — the real production caller
     * (UsersController.createUser) always supplies both.
     */
    actorRole?: AppRole
    actorId?: string
  }): Promise<User> {
    // ut-12: ADMIN creation is reserved to the seed pool — block here as a
    // defense-in-depth measure even if the controller / Roles guard let it slip.
    if (data.role === 'ADMIN') {
      throw new ForbiddenException('Создание ADMIN запрещено — пул фиксирован')
    }
    // Drop role - phase 1: DROP must be created via `createDrop` (mandatory
    // team section). Reject here defensively in case a malformed request
    // reaches the legacy endpoint.
    if (data.role === 'DROP') {
      throw new BadRequestException('Создание DROP — через POST /api/users/drops')
    }
    if (data.teamMode === 'JOIN_DROP_TEAM') {
      if (data.role !== 'SENIOR') {
        throw new BadRequestException('teamMode=JOIN_DROP_TEAM доступен только при создании SENIOR')
      }
      if (!data.dropTeamId) {
        throw new BadRequestException('dropTeamId обязателен при teamMode=JOIN_DROP_TEAM')
      }
      // MED-3 (security-review round 2): `TeamsService.addSeniorToDropTeam`
      // explicitly delegates RBAC to its caller (see that method's own
      // docblock) — without this check, an HR actor could attach the SENIOR
      // they are provisioning to ANY drop-team with a free senior slot, not
      // just their own, reaching into another team's payment routing. ADMIN
      // is exempt (full control, as everywhere else in this method).
      if (data.actorRole === 'HR') {
        const isMember = await this.teamsService.isActiveMemberOfTeam(
          data.dropTeamId,
          data.actorId ?? '',
        )
        if (!isMember) {
          throw new ForbiddenException('HR может присоединять синьора только к своей drop-команде')
        }
      }
    }
    const existing = await this.findByEmail(data.email)
    if (existing) throw new ConflictException('User with this email already exists')

    // Build insert payload — only include payment columns when relevant so we
    // keep "no requisites" rows clean (null in DB rather than empty string).
    const insertValues: typeof users.$inferInsert = {
      email: data.email,
      displayName: data.displayName,
      role: data.role,
      telegram: data.telegram ?? null,
      phone: data.phone ?? null,
      // No auto-generated (dicebear) placeholder — new users get null here and
      // the UI (UserAvatar) falls back to initials until a real photo/upload
      // is set.
      avatarUrl: data.avatarUrl ?? null,
      techStack: data.techStack ?? null,
    }
    if (data.seniorSharePercent !== undefined)
      insertValues.seniorSharePercent = data.seniorSharePercent
    if (data.monthlySalary != null) insertValues.monthlySalary = String(data.monthlySalary)
    if (data.salaryCurrency) insertValues.salaryCurrency = data.salaryCurrency
    if (data.legalFullName?.trim()) insertValues.legalFullName = data.legalFullName.trim()

    // Payment requisites — only persist the fields matching the selected method.
    if (data.paymentMethod) {
      insertValues.paymentMethod = data.paymentMethod
      if (data.paymentMethod === 'USDT_ERC20') {
        insertValues.walletUsdtErc20 = data.walletUsdtErc20 ?? null
        insertValues.walletUsdtLabel = data.walletUsdtLabel ?? null
      } else {
        insertValues.bankUahRecipient = data.bankUahRecipient ?? null
        insertValues.bankUahIban = data.bankUahIban ?? null
        insertValues.bankUahRnokpp = data.bankUahRnokpp ?? null
        insertValues.bankUahBankName = data.bankUahBankName ?? null
      }
    }

    const rows = await this.db.db.insert(users).values(insertValues).returning()

    const created = rows[0]
    if (!created) throw new Error('Failed to create user')

    // Seed initial audit event — always has changes so record() won't skip it
    await this.auditLogService.record({
      actorId: null,
      targetId: created.id,
      action: 'profile_created',
      changes: {
        displayName: { before: null, after: created.displayName },
        role: { before: null, after: created.role },
      },
    })

    if (data.role === 'SENIOR') {
      if (data.teamMode === 'JOIN_DROP_TEAM' && data.dropTeamId) {
        // Drop role - phase 1: skip auto-team creation. Attach the new
        // SENIOR to the requested drop-team. `addSeniorToDropTeam` enforces
        // type+empty-slot+other-team checks; surfaces clear 400 on conflict.
        await this.teamsService.addSeniorToDropTeam(data.dropTeamId, created.id)
      } else {
        // Default `CREATE_NEW` path — unchanged from pre-drop legacy.
        const [team] = await this.db.db
          .insert(teams)
          .values({ name: `Команда ${data.displayName}` })
          .returning()
        if (team) {
          const memberIds = [
            created.id,
            ...(data.hrIds ?? []),
            ...(data.accountantId ? [data.accountantId] : []),
          ]
          for (const userId of memberIds) {
            await this.db.db.insert(teamMembers).values({ teamId: team.id, userId })
          }
        }
      }
    }

    if (data.role === 'JUNIOR' && data.projectId) {
      await this.db.db.insert(projectMembers).values({
        projectId: data.projectId,
        userId: created.id,
      })
    }

    return created
  }

  async adminUpdateUser(
    id: string,
    data: {
      email?: string
      displayName?: string
      role?: AppRole
      telegram?: string | null | undefined
      phone?: string | null | undefined
      avatarUrl?: string | null | undefined
      avatarDocumentId?: string | null | undefined
      techStack?: string[] | null | undefined
      seniorSharePercent?: number | undefined
      dropSharePercent?: number | undefined
      monthlySalary?: number | null | undefined
      salaryCurrency?: 'USDT' | 'USD' | 'EUR' | 'UAH' | undefined
      paymentMethod?: 'USDT_ERC20' | 'BANK_UAH_FOP' | undefined
      walletUsdtErc20?: string | null | undefined
      walletUsdtLabel?: string | null | undefined
      bankUahRecipient?: string | null | undefined
      bankUahIban?: string | null | undefined
      bankUahRnokpp?: string | null | undefined
      bankUahBankName?: string | null | undefined
      hrIds?: string[] | undefined
      accountantId?: string | null | undefined
      teamTelegramChannel?: string | null | undefined
      /**
       * Legal full name (Cyrillic, order: Surname First Patronymic).
       * Used in MSA contract instead of displayName. Optional in admin update.
       */
      legalFullName?: string | undefined
      /**
       * Ukrainian registration address (ФОП).
       * Used in contract template as {{registrationAddress}}.
       */
      registrationAddress?: string | null | undefined
    },
    actorId: string | null = null,
  ): Promise<User> {
    // ut-10/11: ADMIN protection. Fetch the existing row first so we can apply
    // role-aware guards before any UPDATE statement.
    const existing = await this.findById(id)
    if (!existing) throw new NotFoundException('User not found')

    if (existing.role === 'ADMIN' && actorId !== null && existing.id !== actorId) {
      throw new ForbiddenException('Cannot edit another admin')
    }
    if (
      data.role !== undefined &&
      existing.role === 'ADMIN' &&
      actorId !== null &&
      existing.id === actorId &&
      data.role !== 'ADMIN'
    ) {
      throw new ForbiddenException('Cannot change own ADMIN role')
    }
    // MED (security-audit authz-hardening): mirror changeRole's privilege-
    // escalation guards here. PATCH /:id/role already forbids elevating
    // anyone to ADMIN (fixed pool) and moving a user to DROP (must go
    // through POST /users/drops, which atomically provisions the mandatory
    // drop-team). Without this, the SAME `role` field on the general
    // PATCH /:id body bypassed both invariants — this only fires on an
    // ACTUAL role change (data.role !== existing.role) so the routine
    // round-trip of resubmitting the current role (e.g. an ADMIN self-edit,
    // or editing a DROP user's other fields) is unaffected.
    if (data.role !== undefined && data.role !== existing.role) {
      if (data.role === 'ADMIN') {
        throw new ForbiddenException('Назначение роли ADMIN запрещено — пул фиксирован')
      }
      if (data.role === 'DROP') {
        throw new ForbiddenException('Изменение роли на DROP — через POST /api/users/drops')
      }
    }
    // ut-17: Telegram channel of the team is a SENIOR-only field. The pair
    // invariant SENIOR ≡ team means setting it for any other role would be a
    // contract violation — reject early with 400.
    const effectiveRole = data.role ?? existing.role
    if (data.teamTelegramChannel !== undefined && effectiveRole !== 'SENIOR') {
      throw new BadRequestException('Telegram channel can only be set for SENIOR users')
    }
    // Email uniqueness check — only when actually changing it.
    if (data.email !== undefined && data.email !== existing.email) {
      const conflict = await this.findByEmail(data.email)
      if (conflict && conflict.id !== id) {
        throw new ConflictException('User with this email already exists')
      }
    }

    const set: Partial<{
      email: string
      displayName: string
      role: AppRole
      telegram: string | null
      phone: string | null
      avatarUrl: string | null
      avatarDocumentId: string | null
      techStack: string[] | null
      seniorSharePercent: number
      dropSharePercent: number
      monthlySalary: string | null
      salaryCurrency: 'USDT' | 'USD' | 'EUR' | 'UAH'
      paymentMethod: 'USDT_ERC20' | 'BANK_UAH_FOP'
      walletUsdtErc20: string | null
      walletUsdtLabel: string | null
      bankUahRecipient: string | null
      bankUahIban: string | null
      bankUahRnokpp: string | null
      bankUahBankName: string | null
      legalFullName: string | null
      registrationAddress: string | null
      updatedAt: Date
    }> = { updatedAt: new Date() }

    if (data.email !== undefined) set.email = data.email
    if (data.displayName !== undefined) set.displayName = data.displayName
    if (data.role !== undefined) set.role = data.role
    if ('telegram' in data) set.telegram = data.telegram ?? null
    if ('phone' in data) set.phone = data.phone ?? null
    if ('avatarUrl' in data) set.avatarUrl = data.avatarUrl ?? null
    if ('avatarDocumentId' in data) {
      // ADMIN may attach any AVATAR document; ownership check is bypassed
      // (admin operating on someone else's profile). Still enforce category.
      await this.assertAvatarDocument(data.avatarDocumentId ?? null, id)
      set.avatarDocumentId = data.avatarDocumentId ?? null
    }
    if ('techStack' in data) set.techStack = data.techStack ?? null
    // Share-percent fields — role-scoped writes: only persist when the
    // effective role actually uses the field, so an "orphaned" value can't
    // surface later if the user is promoted into that role. Mirrors the
    // UserDialog finance section (SENIOR-slider / DROP-slider / salary-field).
    if (data.seniorSharePercent !== undefined && effectiveRole === 'SENIOR')
      set.seniorSharePercent = data.seniorSharePercent
    if (data.dropSharePercent !== undefined && effectiveRole === 'DROP')
      set.dropSharePercent = data.dropSharePercent
    if ('monthlySalary' in data)
      set.monthlySalary = data.monthlySalary != null ? String(data.monthlySalary) : null
    if (data.salaryCurrency !== undefined) set.salaryCurrency = data.salaryCurrency
    if (data.legalFullName !== undefined) set.legalFullName = data.legalFullName.trim() || null
    if ('registrationAddress' in data)
      set.registrationAddress = data.registrationAddress?.trim() || null

    // Payment requisites — switching method clears the other branch's fields.
    if (data.paymentMethod !== undefined) {
      set.paymentMethod = data.paymentMethod
      if (data.paymentMethod === 'USDT_ERC20') {
        if ('walletUsdtErc20' in data) set.walletUsdtErc20 = data.walletUsdtErc20 ?? null
        if ('walletUsdtLabel' in data) set.walletUsdtLabel = data.walletUsdtLabel ?? null
        set.bankUahRecipient = null
        set.bankUahIban = null
        set.bankUahRnokpp = null
        set.bankUahBankName = null
      } else {
        if ('bankUahRecipient' in data) set.bankUahRecipient = data.bankUahRecipient ?? null
        if ('bankUahIban' in data) set.bankUahIban = data.bankUahIban ?? null
        if ('bankUahRnokpp' in data) set.bankUahRnokpp = data.bankUahRnokpp ?? null
        if ('bankUahBankName' in data) set.bankUahBankName = data.bankUahBankName ?? null
        set.walletUsdtErc20 = null
        set.walletUsdtLabel = null
      }
    } else {
      // No method switch — but the admin may still patch individual fields of
      // the current method (e.g. update IBAN without changing payment method).
      if ('walletUsdtErc20' in data) set.walletUsdtErc20 = data.walletUsdtErc20 ?? null
      if ('walletUsdtLabel' in data) set.walletUsdtLabel = data.walletUsdtLabel ?? null
      if ('bankUahRecipient' in data) set.bankUahRecipient = data.bankUahRecipient ?? null
      if ('bankUahIban' in data) set.bankUahIban = data.bankUahIban ?? null
      if ('bankUahRnokpp' in data) set.bankUahRnokpp = data.bankUahRnokpp ?? null
      if ('bankUahBankName' in data) set.bankUahBankName = data.bankUahBankName ?? null
    }

    // The user UPDATE + downstream SENIOR-only side effects (team composition
    // reconcile + team telegram channel propagation) are committed as one
    // transaction. Pair invariant SENIOR ≡ team means a partial commit (user
    // saved but team comms lost) would leave inconsistent state on the
    // critical comms field — atomicity matters here.
    const updated = await this.db.db.transaction(async (tx) => {
      const rows = await tx.update(users).set(set).where(eq(users.id, id)).returning()

      const u = rows[0]
      if (!u) throw new NotFoundException('User not found')

      // SENIOR-only: optional team composition reconcile.
      if (u.role === 'SENIOR' && (data.hrIds !== undefined || data.accountantId !== undefined)) {
        await this.reconcileSeniorTeamTx(
          tx,
          u.id,
          {
            hrIds: data.hrIds,
            accountantId: data.accountantId,
          },
          actorId,
        )
      }

      // ut-17: propagate teamTelegramChannel onto the senior's team (same tx).
      if (u.role === 'SENIOR' && data.teamTelegramChannel !== undefined) {
        await this.updateSeniorTeamTelegramChannelTx(tx, u.id, data.teamTelegramChannel, actorId)
      }

      return u
    })

    return updated
  }

  /**
   * Update `teams.telegram_channel` for the team owned by `seniorId` and write
   * a `team_updated` audit row inside the SAME transaction. No-op if the value
   * hasn't actually changed (avoids spurious audit entries for re-saves).
   */
  private async updateSeniorTeamTelegramChannelTx(
    tx: DrizzleTx,
    seniorId: string,
    value: string | null,
    actorId: string | null,
  ): Promise<void> {
    const seniorMembership = await tx
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (!seniorMembership) return
    const teamId = seniorMembership.teamId

    const team = await tx
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .then((rows) => rows[0])
    if (!team) return

    const previous = team.telegramChannel ?? null
    const next = value ?? null
    if (previous === next) return

    await tx
      .update(teams)
      .set({ telegramChannel: next, updatedAt: new Date() })
      .where(eq(teams.id, teamId))

    await this.teamAuditLogService.record(
      {
        actorId,
        targetId: teamId,
        action: 'team_updated',
        changes: { telegramChannel: { before: previous, after: next } },
      },
      tx,
    )
  }

  /**
   * Transactional variant of reconcileSeniorTeam. All membership writes and
   * audit log entries use the supplied `tx` so adminUpdateUser's outer
   * transaction can commit them atomically with the user UPDATE.
   *
   * Active members (`leftAt IS NULL`) are diffed against the target sets:
   *  - new HR/Acc -> insert team_member or restore via leftAt=NULL on existing row
   *  - removed HR/Acc -> set leftAt=now()
   * Each delta is logged into `team_audit_log`.
   */
  private async reconcileSeniorTeamTx(
    tx: DrizzleTx,
    seniorId: string,
    data: { hrIds?: string[] | undefined; accountantId?: string | null | undefined },
    actorId: string | null,
  ): Promise<void> {
    // Resolve the senior's team via team_members (teams has no seniorId column —
    // a SENIOR is always team_member of exactly one team by business invariant).
    const seniorMembership = await tx
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (!seniorMembership) return
    const teamId = seniorMembership.teamId

    const activeMembers: Array<{ userId: string; id: string; role: User['role'] }> = await tx
      .select({
        userId: teamMembers.userId,
        id: teamMembers.id,
        role: users.role,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, teamId), isNull(teamMembers.leftAt)))

    const now = new Date()

    if (data.hrIds !== undefined) {
      const desiredHrIds = new Set(data.hrIds)
      const currentHrIds = new Set(
        activeMembers.filter((m) => m.role === 'HR').map((m) => m.userId),
      )

      // To remove: currently active HR not in desired set.
      const toRemove = [...currentHrIds].filter((id) => !desiredHrIds.has(id))
      // To add: desired but not currently active.
      const toAdd = [...desiredHrIds].filter((id) => !currentHrIds.has(id))

      for (const userId of toRemove) {
        await tx
          .update(teamMembers)
          .set({ leftAt: now })
          .where(
            and(
              eq(teamMembers.teamId, teamId),
              eq(teamMembers.userId, userId),
              isNull(teamMembers.leftAt),
            ),
          )
        await this.teamAuditLogService.record(
          {
            actorId,
            targetId: teamId,
            action: 'team_member_removed',
            changes: {
              userId: { before: userId, after: null },
              role: { before: 'HR', after: null },
            },
          },
          tx,
        )
      }
      for (const userId of toAdd) {
        await this.upsertTeamMemberTx(tx, teamId, userId)
        await this.teamAuditLogService.record(
          {
            actorId,
            targetId: teamId,
            action: 'team_member_added',
            changes: {
              userId: { before: null, after: userId },
              role: { before: null, after: 'HR' },
            },
          },
          tx,
        )
      }
    }

    if (data.accountantId !== undefined) {
      const desiredId = data.accountantId ?? null
      const currentAcc = activeMembers.find((m) => m.role === 'ACCOUNTANT')
      const currentId = currentAcc?.userId ?? null

      if (currentId !== desiredId) {
        if (currentId) {
          await tx
            .update(teamMembers)
            .set({ leftAt: now })
            .where(
              and(
                eq(teamMembers.teamId, teamId),
                eq(teamMembers.userId, currentId),
                isNull(teamMembers.leftAt),
              ),
            )
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: teamId,
              action: 'team_member_removed',
              changes: {
                userId: { before: currentId, after: null },
                role: { before: 'ACCOUNTANT', after: null },
              },
            },
            tx,
          )
        }
        if (desiredId) {
          await this.upsertTeamMemberTx(tx, teamId, desiredId)
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: teamId,
              action: 'team_member_added',
              changes: {
                userId: { before: null, after: desiredId },
                role: { before: null, after: 'ACCOUNTANT' },
              },
            },
            tx,
          )
        }
      }
    }
  }

  /**
   * Insert team_member; if row already exists (left previously) — clear leftAt to restore.
   * Uses the supplied transaction handle so it shares the outer atomicity boundary.
   */
  private async upsertTeamMemberTx(tx: DrizzleTx, teamId: string, userId: string): Promise<void> {
    const existing = await tx
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .then((rows) => rows[0])
    if (existing) {
      if (existing.leftAt !== null) {
        await tx.update(teamMembers).set({ leftAt: null }).where(eq(teamMembers.id, existing.id))
      }
      return
    }
    await tx.insert(teamMembers).values({ teamId, userId })
  }

  async updateProfile(
    id: string,
    data: {
      displayName?: string
      telegram?: string | null
      phone?: string | null
      techStack?: string[] | null
      avatarDocumentId?: string | null
    },
  ): Promise<User> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (data.displayName !== undefined) set.displayName = data.displayName
    if ('telegram' in data) set.telegram = data.telegram ?? null
    if ('phone' in data) set.phone = data.phone ?? null
    if ('techStack' in data) set.techStack = data.techStack ?? null
    if ('avatarDocumentId' in data) {
      // Self-update: document must be owned by `id`.
      await this.assertAvatarDocument(data.avatarDocumentId ?? null, id)
      set.avatarDocumentId = data.avatarDocumentId ?? null
    }

    const rows = await this.db.db.update(users).set(set).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  async updateRequisites(
    id: string,
    data: {
      paymentMethod: 'USDT_ERC20' | 'BANK_UAH_FOP'
      walletUsdtErc20?: string
      walletUsdtLabel?: string | null
      bankUahRecipient?: string
      bankUahIban?: string
      bankUahRnokpp?: string
      bankUahBankName?: string | null
    },
  ): Promise<User> {
    const set: Record<string, unknown> = {
      paymentMethod: data.paymentMethod,
      updatedAt: new Date(),
    }
    if (data.paymentMethod === 'USDT_ERC20') {
      set.walletUsdtErc20 = data.walletUsdtErc20 ?? null
      set.walletUsdtLabel = data.walletUsdtLabel ?? null
      set.bankUahRecipient = null
      set.bankUahIban = null
      set.bankUahRnokpp = null
      set.bankUahBankName = null
    } else {
      set.bankUahRecipient = data.bankUahRecipient ?? null
      set.bankUahIban = data.bankUahIban ?? null
      set.bankUahRnokpp = data.bankUahRnokpp ?? null
      set.bankUahBankName = data.bankUahBankName ?? null
      set.walletUsdtErc20 = null
      set.walletUsdtLabel = null
    }
    const rows = await this.db.db.update(users).set(set).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  async changeRole(id: string, role: User['role'], actorId: string): Promise<User> {
    // SEC-03 (MED): privilege-escalation guards. These mirror the protections in
    // adminUpdateUser and createUser so that the lightweight PATCH /:id/role
    // endpoint cannot be used to bypass them.

    // (1) ADMIN pool is fixed — elevation to ADMIN is always forbidden here.
    if (role === 'ADMIN') {
      throw new ForbiddenException('Назначение роли ADMIN запрещено — пул фиксирован')
    }

    // (2) DROP must be created via the dedicated POST /users/drops endpoint
    // which provisions the associated drop-team atomically. Routing through
    // changeRole would leave the user without a team (broken invariant).
    if (role === 'DROP') {
      throw new ForbiddenException('Изменение роли на DROP — через POST /api/users/drops')
    }

    const existing = await this.findById(id)
    if (!existing) throw new NotFoundException('User not found')

    // (3) Cannot change the role of any ADMIN (even to a lower role) unless
    // the actor is editing their own record — and even then self-demotion is
    // blocked by rule (4). Mirrors adminUpdateUser :410.
    if (existing.role === 'ADMIN' && actorId !== existing.id) {
      throw new ForbiddenException('Нельзя изменить роль другого администратора')
    }

    // (4) An ADMIN cannot demote themselves via this endpoint.
    if (existing.role === 'ADMIN' && actorId === existing.id) {
      throw new ForbiddenException('Администратор не может сменить собственную роль')
    }

    const rows = await this.db.db
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  async changeSalary(
    id: string,
    data: {
      monthlySalary?: number | null
      salaryCurrency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
      seniorSharePercent?: number
    },
  ): Promise<User> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (data.monthlySalary !== undefined)
      set.monthlySalary = data.monthlySalary != null ? String(data.monthlySalary) : null
    if (data.salaryCurrency !== undefined) set.salaryCurrency = data.salaryCurrency
    if (data.seniorSharePercent !== undefined) set.seniorSharePercent = data.seniorSharePercent
    const rows = await this.db.db.update(users).set(set).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  async setAdminNote(id: string, note: string | null): Promise<User> {
    const rows = await this.db.db
      .update(users)
      .set({ adminNote: note, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  /**
   * Soft-archive a user with role-specific cascade:
   *  - SENIOR: paired with their team — archives team + active projects + sets leftAt
   *    for HR/Acc team_members (but NOT for senior's own team_member row).
   *  - HR/ACCOUNTANT: sets leftAt for their team memberships.
   *  - JUNIOR: sets leftAt for their project memberships (and any team_members).
   *  - ADMIN: just the user row.
   * Audit log entries written to user_audit_log + team_audit_log + project_audit_log.
   * All mutations in one transaction — any throw rolls back the whole cascade.
   *
   * @param id user id
   * @param actorId admin who triggered archive (for audit log)
   */
  async archive(id: string, actorId: string | null = null): Promise<User> {
    return this.db.db.transaction(async (tx) => {
      const user = await tx
        .select()
        .from(users)
        .where(eq(users.id, id))
        .then((rows) => rows[0])
      if (!user) throw new NotFoundException('User not found')
      if (user.archivedAt) throw new BadRequestException('User is already archived')
      // Defense-in-depth: ADMIN cannot archive another ADMIN. The controller
      // already blocks self-archive; this guard makes ADMINs mutually
      // indestructible regardless of how the endpoint is called.
      if (user.role === 'ADMIN' && actorId !== null && user.id !== actorId) {
        throw new ForbiddenException('Cannot archive another admin')
      }

      const now = new Date()

      await tx.update(users).set({ archivedAt: now, updatedAt: now }).where(eq(users.id, id))

      if (user.role === 'SENIOR') {
        // Pair-archive: senior's team + projects. SENIOR's own team_member row is NOT touched.
        const seniorMembership = await tx
          .select()
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
          .then((rows) => rows[0])
        if (seniorMembership) {
          const teamId = seniorMembership.teamId
          await tx
            .update(teams)
            .set({ archivedAt: now, updatedAt: now })
            .where(eq(teams.id, teamId))
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: teamId,
              action: 'team_archived',
              changes: { archivedAt: { before: null, after: now.toISOString() } },
            },
            tx,
          )

          // Snapshot HR/Acc that get detached so we can write per-member audit entries
          // BEFORE the bulk UPDATE marks them as left.
          const hrAccToRemove = await tx
            .select({ userId: teamMembers.userId, role: users.role })
            .from(teamMembers)
            .innerJoin(users, eq(users.id, teamMembers.userId))
            .where(
              and(
                eq(teamMembers.teamId, teamId),
                isNull(teamMembers.leftAt),
                ne(teamMembers.userId, id),
              ),
            )

          // Set leftAt for HR/Acc — keep SENIOR's own row untouched (ne userId, id).
          await tx
            .update(teamMembers)
            .set({ leftAt: now })
            .where(
              and(
                eq(teamMembers.teamId, teamId),
                isNull(teamMembers.leftAt),
                ne(teamMembers.userId, id),
              ),
            )

          // One team_member_removed audit entry per detached HR/Accountant, so the
          // team's history mirrors a manual removal (matches HR-only branch below).
          for (const m of hrAccToRemove) {
            await this.teamAuditLogService.record(
              {
                actorId,
                targetId: teamId,
                action: 'team_member_removed',
                changes: {
                  userId: { before: m.userId, after: null },
                  role: { before: m.role, after: null },
                },
              },
              tx,
            )
          }
        }

        // Archive all of senior's active projects + remove active project_members.
        const ownedProjects = await tx
          .select()
          .from(projects)
          .where(and(eq(projects.seniorId, id), isNull(projects.archivedAt)))

        for (const p of ownedProjects) {
          await tx
            .update(projects)
            .set({ archivedAt: now, updatedAt: now })
            .where(eq(projects.id, p.id))
          await this.projectAuditLogService.record(
            {
              actorId,
              targetId: p.id,
              action: 'project_archived',
              changes: { archivedAt: { before: null, after: now.toISOString() } },
            },
            tx,
          )
          // Cascade-remove active JUNIORs from project_members.
          await tx
            .update(projectMembers)
            .set({ leftAt: now })
            .where(and(eq(projectMembers.projectId, p.id), isNull(projectMembers.leftAt)))
        }
      } else if (user.role === 'HR' || user.role === 'ACCOUNTANT') {
        // Set leftAt across all team memberships.
        const memberships = await tx
          .select({ id: teamMembers.id, teamId: teamMembers.teamId })
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
        if (memberships.length > 0) {
          await tx
            .update(teamMembers)
            .set({ leftAt: now })
            .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
          for (const m of memberships) {
            await this.teamAuditLogService.record(
              {
                actorId,
                targetId: m.teamId,
                action: 'team_member_removed',
                changes: {
                  userId: { before: id, after: null },
                  role: { before: user.role, after: null },
                },
              },
              tx,
            )
          }
        }
      } else if (user.role === 'JUNIOR') {
        // Detach JUNIOR from all active project memberships.
        // NB: JUNIOR is never persisted in `team_members` — team membership for
        // JUNIORs is derived state (project membership ⇒ implicit team), see
        // CLAUDE.md §Teams. So we deliberately do NOT update team_members here.
        const projectMemberships = await tx
          .select({ id: projectMembers.id, projectId: projectMembers.projectId })
          .from(projectMembers)
          .where(and(eq(projectMembers.userId, id), isNull(projectMembers.leftAt)))
        if (projectMemberships.length > 0) {
          await tx
            .update(projectMembers)
            .set({ leftAt: now })
            .where(and(eq(projectMembers.userId, id), isNull(projectMembers.leftAt)))
          for (const pm of projectMemberships) {
            await this.projectAuditLogService.record(
              {
                actorId,
                targetId: pm.projectId,
                action: 'project_member_removed',
                changes: { userId: { before: id, after: null } },
              },
              tx,
            )
          }
        }
      } else if (user.role === 'DROP') {
        // Drop role - phase 1: pair-archive drop + drop-team + drop-projects.
        // Active SENIOR (if any) is detached but NOT archived. Delegated to
        // TeamsService.archiveDropTeam inside the same transaction.
        const dropMembership = await tx
          .select()
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
          .then((rows) => rows[0])
        if (dropMembership) {
          await this.teamsService.archiveDropTeam(dropMembership.teamId, tx)
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: dropMembership.teamId,
              action: 'team_archived',
              changes: { archivedAt: { before: null, after: now.toISOString() } },
            },
            tx,
          )
        }
      }
      // ADMIN: no dependencies.

      // Final user_audit_log entry.
      await this.auditLogService.record(
        {
          actorId,
          targetId: id,
          action: 'user_archived',
          changes: { archivedAt: { before: null, after: now.toISOString() } },
        },
        tx,
      )

      const updated = await tx
        .select()
        .from(users)
        .where(eq(users.id, id))
        .then((rows) => rows[0])
      if (!updated) throw new NotFoundException('User not found')
      return updated
    })
  }

  /**
   * Restore an archived user. SENIOR restoration is paired with their team —
   * projects remain archived; HR/Acc team_members.leftAt is NOT restored.
   * For HR/Acc/Junior/Admin — only the user row is restored, memberships stay closed.
   */
  async unarchive(id: string, actorId: string | null = null): Promise<User> {
    return this.db.db.transaction(async (tx) => {
      await this.unarchivePairTx(tx, id, actorId)
      const updated = await tx
        .select()
        .from(users)
        .where(eq(users.id, id))
        .then((rows) => rows[0])
      if (!updated) throw new NotFoundException('User not found')
      return updated
    })
  }

  /**
   * Pair-unarchive primitive that runs ENTIRELY within the caller's transaction.
   * Used by:
   *   - `UsersService.unarchive()` — wraps this in its own tx
   *   - `ProjectsService.unarchive(cascade=true)` — passes its outer tx so the
   *     project unarchive + senior/team unarchive commit atomically (no nested
   *     transactions, no orphaned state if the outer flow throws).
   *
   * IMPORTANT: All mutations and audit log writes use the supplied `tx` — never
   * `this.db.db` — so rollback discards everything together. Caller is
   * responsible for opening the transaction.
   */
  async unarchivePairTx(tx: DrizzleTx, id: string, actorId: string | null = null): Promise<void> {
    const user = await tx
      .select()
      .from(users)
      .where(eq(users.id, id))
      .then((rows) => rows[0])
    if (!user) throw new NotFoundException('User not found')
    if (!user.archivedAt) throw new BadRequestException('User is not archived')

    const now = new Date()
    const previousArchivedAt = user.archivedAt

    await tx.update(users).set({ archivedAt: null, updatedAt: now }).where(eq(users.id, id))

    await this.auditLogService.record(
      {
        actorId,
        targetId: id,
        action: 'user_unarchived',
        changes: { archivedAt: { before: previousArchivedAt?.toISOString() ?? null, after: null } },
      },
      tx,
    )

    if (user.role === 'SENIOR') {
      // Pair-unarchive: also unarchive the team via senior's team_member row.
      // We require `leftAt IS NULL` because senior's own membership is the
      // permanent identity link and stays active even while archived. A row
      // with `leftAt != NULL` would be stale data we shouldn't follow.
      const seniorMembership = await tx
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
        .then((rows) => rows[0])
      if (seniorMembership) {
        const team = await tx
          .select()
          .from(teams)
          .where(eq(teams.id, seniorMembership.teamId))
          .then((rows) => rows[0])
        if (team?.archivedAt) {
          const teamPreviousArchivedAt = team.archivedAt
          await tx
            .update(teams)
            .set({ archivedAt: null, updatedAt: now })
            .where(eq(teams.id, team.id))
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: team.id,
              action: 'team_unarchived',
              changes: {
                archivedAt: { before: teamPreviousArchivedAt.toISOString(), after: null },
              },
            },
            tx,
          )
        }
      }
      // Projects intentionally stay archived; HR/Acc team_members.leftAt stays.
    }
  }

  /**
   * Returns the cascade impact summary the UI shows before the admin confirms archive.
   * Shape varies by role — see ArchiveImpact union in @crm/shared.
   */
  async getArchiveImpact(id: string): Promise<ArchiveImpact> {
    const user = await this.findById(id)
    if (!user) throw new NotFoundException('User not found')

    if (user.role === 'SENIOR') {
      // Find senior's team via team_members.
      const seniorMembership = await this.db.db.query.teamMembers.findFirst({
        where: and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)),
      })
      let teamName: string | null = null
      let hrAccountantsToBeRemoved = 0
      if (seniorMembership) {
        const team = await this.db.db.query.teams.findFirst({
          where: eq(teams.id, seniorMembership.teamId),
        })
        teamName = team?.name ?? null
        const others = await this.db.db
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, seniorMembership.teamId),
              isNull(teamMembers.leftAt),
              ne(teamMembers.userId, id),
            ),
          )
        hrAccountantsToBeRemoved = others.length
      }
      const seniorProjects = await this.db.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.seniorId, id), isNull(projects.archivedAt)))
      const projectIds = seniorProjects.map((p) => p.id)
      let juniorsAffected = 0
      if (projectIds.length > 0) {
        const activeJuniors = await this.db.db
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(and(inArray(projectMembers.projectId, projectIds), isNull(projectMembers.leftAt)))
        juniorsAffected = activeJuniors.length
      }
      return {
        type: 'user',
        role: 'SENIOR',
        isPaired: true,
        teamName,
        projectsCount: seniorProjects.length,
        juniorsAffected,
        hrAccountantsToBeRemoved,
      }
    }

    if (user.role === 'HR' || user.role === 'ACCOUNTANT') {
      const memberships = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
      return { type: 'user', role: user.role, teamsCount: memberships.length }
    }

    if (user.role === 'JUNIOR') {
      const memberships = await this.db.db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(and(eq(projectMembers.userId, id), isNull(projectMembers.leftAt)))
      return { type: 'user', role: 'JUNIOR', projectsCount: memberships.length }
    }

    if (user.role === 'DROP') {
      // Drop role - phase 1: archive impact mirrors SENIOR pair behavior.
      // teamName + projectsCount come from the drop's team + drop-projects.
      const dropMembership = await this.db.db.query.teamMembers.findFirst({
        where: and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)),
      })
      let teamName: string | null = null
      let hrAccountantsToBeRemoved = 0
      if (dropMembership) {
        const team = await this.db.db.query.teams.findFirst({
          where: eq(teams.id, dropMembership.teamId),
        })
        teamName = team?.name ?? null
        const others = await this.db.db
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, dropMembership.teamId),
              isNull(teamMembers.leftAt),
              ne(teamMembers.userId, id),
            ),
          )
        hrAccountantsToBeRemoved = others.length
      }
      const dropProjects = await this.db.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.dropId, id), isNull(projects.archivedAt)))
      return {
        type: 'user',
        role: 'DROP',
        isPaired: true,
        teamName,
        projectsCount: dropProjects.length,
        hrAccountantsToBeRemoved,
      }
    }

    // ADMIN
    return { type: 'user', role: 'ADMIN', noDependencies: true }
  }

  /**
   * Returns flat list of teammates for a given user. Combines:
   *  - team_members of teams associated with the user (HR, ACCOUNTANT, SENIOR)
   *  - JUNIORs active in projects owned by those teams' seniors
   * Excludes the user themselves.
   *
   * Mapping of "user → their team(s)":
   *  - SENIOR: teams owned by this senior (teams.senior_id = user.id is implicit via team_members)
   *  - JUNIOR: teams of seniors whose projects this junior is active in
   *  - HR / ACCOUNTANT: teams where the user is a team_member
   *  - ADMIN: no teams (returns empty)
   */
  async getTeamMembersForUser(userId: string): Promise<TeamMemberPreview[]> {
    const user = await this.findById(userId)
    if (!user) throw new NotFoundException('User not found')
    if (user.role === 'ADMIN') return []

    // Step 1: Resolve set of seniorIds whose teams this user belongs to
    let seniorIds: string[] = []

    if (user.role === 'SENIOR') {
      seniorIds = [user.id]
    } else if (user.role === 'JUNIOR') {
      const activeProjects = await this.db.db
        .select({ seniorId: projects.seniorId })
        .from(projectMembers)
        .innerJoin(projects, eq(projectMembers.projectId, projects.id))
        .where(and(eq(projectMembers.userId, userId), isNull(projectMembers.leftAt)))
      seniorIds = Array.from(new Set(activeProjects.map((p) => p.seniorId)))
    } else if (user.role === 'HR' || user.role === 'ACCOUNTANT') {
      // MED-2 (security-review round 2): `isNull(leftAt)` — a soft-removed
      // HR/ACCOUNTANT membership must not resolve a team roster anymore.
      // Mirrors the HIGH-1 fix in teams.service.ts (isHrOfTeam/assertAccess).
      const memberships = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, userId), isNull(teamMembers.leftAt)))
      if (memberships.length === 0) return []
      const teamIds = memberships.map((m) => m.teamId)
      const seniorsInTeams = await this.db.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(users, eq(teamMembers.userId, users.id))
        .where(and(inArray(teamMembers.teamId, teamIds), eq(users.role, 'SENIOR')))
      seniorIds = Array.from(new Set(seniorsInTeams.map((s) => s.userId)))
    } else if (user.role === 'DROP') {
      // Drop role - phase 1: drop's "team members" are the drop-team itself
      // (HR + accountant + optional active senior). JUNIORs are not surfaced.
      const dropMemberships = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, userId), isNull(teamMembers.leftAt)))
      if (dropMemberships.length === 0) return []
      const teamIds = dropMemberships.map((m) => m.teamId)
      const memberRows = await this.db.db
        .select({
          id: users.id,
          displayName: users.displayName,
          role: users.role,
          avatarUrl: users.avatarUrl,
          avatarDocumentId: users.avatarDocumentId,
        })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(
            inArray(teamMembers.teamId, teamIds),
            isNull(teamMembers.leftAt),
            ne(users.id, userId),
          ),
        )
      return memberRows
    }

    if (seniorIds.length === 0) return []

    // Step 2: Collect team_members (SENIOR + HR + ACCOUNTANT) across those seniors' teams.
    // Teams are linked to senior via team_members (the SENIOR is itself a member).
    // MED-2 (security-review round 2): `isNull(leftAt)` on BOTH queries below —
    // a detached (rotated-out) senior's team_members row must not resolve a
    // team, and a departed HR/ACCOUNTANT/SENIOR row must not surface in the
    // roster returned to the caller (stale-member leak, distinct from the
    // team-access class of bug already fixed in teams.service.ts).
    const seniorMemberships = await this.db.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.userId, users.id))
      .where(
        and(
          inArray(teamMembers.userId, seniorIds),
          eq(users.role, 'SENIOR'),
          isNull(teamMembers.leftAt),
        ),
      )
    const teamIds = Array.from(new Set(seniorMemberships.map((m) => m.teamId)))

    const memberIds = new Set<string>()
    if (teamIds.length > 0) {
      const tmRows = await this.db.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(and(inArray(teamMembers.teamId, teamIds), isNull(teamMembers.leftAt)))
      tmRows.forEach((r) => memberIds.add(r.userId))
    }

    // Step 3: Add active JUNIORs from projects of those seniors
    const seniorProjects = await this.db.db
      .select({ id: projects.id })
      .from(projects)
      .where(inArray(projects.seniorId, seniorIds))
    const projectIds = seniorProjects.map((p) => p.id)
    if (projectIds.length > 0) {
      const juniorRows = await this.db.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(and(inArray(projectMembers.projectId, projectIds), isNull(projectMembers.leftAt)))
      juniorRows.forEach((r) => memberIds.add(r.userId))
    }

    memberIds.delete(userId)
    if (memberIds.size === 0) return []

    const rows = await this.db.db
      .select({
        id: users.id,
        displayName: users.displayName,
        role: users.role,
        avatarUrl: users.avatarUrl,
        avatarDocumentId: users.avatarDocumentId,
      })
      .from(users)
      .where(inArray(users.id, Array.from(memberIds)))
    return rows
  }

  async buildProfileView(viewer: User, targetId: string) {
    const target = await this.findById(targetId)
    if (!target) throw new NotFoundException('User not found')
    const permissions = await this.accessService.getViewPermissions(viewer, target)

    // Empty tabs means the viewer has no access to this profile at all.
    // Mirror the guard pattern used in GET /:id/team — throw 403 before
    // leaking any user fields (displayName, email, phone, telegram, avatarUrl).
    // Rationale: isSelf always produces non-empty tabs; ADMIN always has tabs;
    // HR has tabs for users in their team; ACCOUNTANT has tabs for all.
    // The only case of empty tabs is e.g. SENIOR viewing a JUNIOR — Broken
    // Access Control (OWASP A01) if we return 200 + personal data here.
    if (permissions.tabs.length === 0) {
      throw new ForbiddenException()
    }

    // ---------------------------------------------------------------------------
    // Build filteredUser with explicit allow-list projection (OWASP A01 guard).
    //
    // IMPORTANT: use an explicit field list rather than `{ ...target }` so that
    // future DB columns do NOT leak automatically before a permissions gate is
    // added. Add new sensitive fields here AND in getViewPermissions flags.
    //
    // Field visibility matrix (viewer → target):
    //   email / phone / telegram (realContacts) — hidden when fields.realContacts=false
    //     (e.g. JUNIOR viewing SENIOR/DROP: legend persona boundary)
    //   adminNote                               — ADMIN only (fields.adminNote), never self
    //   registrationAddress (fopPii)            — ADMIN + self (fields.fopPii)
    //   legalFullName                           — ADMIN + self (fields.legalName)
    //   monthlySalary                           — fields.salary
    //   seniorSharePercent / dropSharePercent   — fields.share
    //   paymentMethod / wallet* / bankUah*      — fields.requisites
    //   techStack                               — fields.techStack
    //   displayName, avatarUrl, avatarDocumentId, role, id — always present
    // ---------------------------------------------------------------------------
    // FilteredUser extends User but allows email to be null when realContacts
    // is masked (e.g. JUNIOR viewing SENIOR). The DB type is string (NOT NULL)
    // but the API contract intentionally redacts it at this layer.
    // SEC-09: exclude googleId — Google's internal identifier is not part of the
    // profile API contract and should not be returned to any caller. The field
    // is used only for OAuth callback flow (updateGoogleId), never for display.
    type FilteredUser = Omit<User, 'email' | 'googleId'> & { email: string | null }
    const filteredUser: FilteredUser = {
      // Always-safe identity fields (persona display, never masked)
      id: target.id,
      displayName: target.displayName,
      role: target.role,
      avatarUrl: target.avatarUrl,
      avatarDocumentId: target.avatarDocumentId,
      archivedAt: target.archivedAt,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,

      // Real contacts — hidden from JUNIOR viewing SENIOR/DROP (legend boundary)
      email: permissions.fields.realContacts ? target.email : null,
      phone: permissions.fields.realContacts ? (target.phone ?? null) : null,
      telegram: permissions.fields.realContacts ? (target.telegram ?? null) : null,

      // Admin-only internal note (never visible to subject or non-ADMIN)
      adminNote: permissions.fields.adminNote ? (target.adminNote ?? null) : null,

      // FOP PII: registrationAddress — ADMIN + self only
      registrationAddress: permissions.fields.fopPii ? (target.registrationAddress ?? null) : null,

      // Passport PII — ADMIN + self only
      legalFullName: permissions.fields.legalName ? (target.legalFullName ?? null) : null,

      // Financial fields — gated by role-based flags
      monthlySalary: permissions.fields.salary ? target.monthlySalary : null,
      salaryCurrency: permissions.fields.salary ? (target.salaryCurrency ?? null) : null,
      seniorSharePercent: permissions.fields.share ? target.seniorSharePercent : 0,
      // Drop role - phase 1: also mask dropSharePercent for non-privileged viewers
      dropSharePercent: permissions.fields.share ? (target.dropSharePercent ?? null) : null,

      // Tech stack
      techStack: permissions.fields.techStack ? (target.techStack ?? null) : null,

      // Payment requisites.
      // `requisitesExcludeWallet` (pre-deploy MEDIUM): an ACCOUNTANT viewing an
      // ADMIN gets the requisites surface EXCEPT the payout destination
      // (wallet/IBAN/recipient/RNOKPP/bank) — admins are not on payroll, so the
      // accountant has no business need for another admin's payout details.
      // `paymentMethod` (the method type, no destination) stays visible.
      paymentMethod: permissions.fields.requisites ? (target.paymentMethod ?? null) : null,
      walletUsdtErc20:
        permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
          ? (target.walletUsdtErc20 ?? null)
          : null,
      walletUsdtLabel:
        permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
          ? (target.walletUsdtLabel ?? null)
          : null,
      bankUahRecipient:
        permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
          ? (target.bankUahRecipient ?? null)
          : null,
      bankUahIban:
        permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
          ? (target.bankUahIban ?? null)
          : null,
      bankUahRnokpp:
        permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
          ? (target.bankUahRnokpp ?? null)
          : null,
      bankUahBankName:
        permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
          ? (target.bankUahBankName ?? null)
          : null,
    }

    const data: Record<string, unknown> = {}
    if (permissions.tabs.includes('overview')) {
      // ToS acceptance — visible to ADMIN or self (except JUNIOR self: data-privacy,
      // task-junior-ut-round3 §6b). JUNIOR sees their own overview tab but does NOT
      // get tosAcceptedAt/tosVersion — the onboarding flow already gated them before
      // reaching the hub, so the date is irrelevant and leaks internal audit info.
      const canSeeTos =
        viewer.role === 'ADMIN' || (viewer.id === target.id && viewer.role !== 'JUNIOR')
      const tosAcceptance = canSeeTos
        ? await this.tosService.getLatestAcceptanceForUser(target.id)
        : null

      data.overview = {
        techStack: permissions.fields.techStack ? (target.techStack ?? []) : null,
        // adminNote — gated by the same permission flag as filteredUser.adminNote
        // (ADMIN viewing another user; never self). Keeps both surfaces consistent.
        adminNote: permissions.fields.adminNote ? (target.adminNote ?? null) : null,
        tosAcceptedAt: tosAcceptance?.acceptedAt.toISOString() ?? null,
        tosVersion: tosAcceptance?.tosVersion ?? null,
      }
    }
    // Other tabs (finance, projects, team, interviews, requisites) — wired in later tasks

    // Pre-deploy MEDIUM: read-access audit for the ACCOUNTANT requisites scope.
    // The base audit log only tracked *writes*; an ACCOUNTANT can read the
    // payout requisites (RNOKPP / IBAN / wallet) of any user company-wide for
    // payroll. Record a `requisites_read` event when an accountant (never self)
    // actually receives requisites, so the read is attributable. Values are NOT
    // logged (it is a read of existing data, not a change) — `changes` records
    // only WHICH fields were exposed, with redacted markers, mirroring how the
    // write-audit redacts SENSITIVE_FIELDS.
    if (viewer.role === 'ACCOUNTANT' && viewer.id !== target.id && permissions.fields.requisites) {
      const exposedFields = (
        [
          'paymentMethod',
          'walletUsdtErc20',
          'walletUsdtLabel',
          'bankUahRecipient',
          'bankUahIban',
          'bankUahRnokpp',
          'bankUahBankName',
        ] as const
      ).filter((f) => (filteredUser as Record<string, unknown>)[f] != null)
      if (exposedFields.length > 0) {
        const changes: Record<string, AuditChange> = {}
        for (const f of exposedFields) {
          // Read-audit: record THAT the field was read, never its plaintext value.
          changes[f] = { before: REDACTED_TOKEN, after: REDACTED_TOKEN }
        }
        await this.auditLogService.record({
          actorId: viewer.id,
          targetId: target.id,
          action: 'requisites_read',
          changes,
        })
      }
    }

    return { user: filteredUser, permissions, data }
  }

  updateGoogleId(id: string, googleId: string): Promise<void> {
    return this.db.db
      .update(users)
      .set({ googleId, updatedAt: new Date() })
      .where(eq(users.id, id))
      .then(() => undefined)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Drop role - phase 1: createDrop + archiveDrop
  //
  // These methods are aditional to the existing `createUser`/`archive`
  // contract. Existing senior/HR/junior/accountant/admin flows are
  // unchanged — only new entry points are added.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Create a DROP user atomically with its mandatory drop-team.
   * RBAC: ADMIN only (enforced in controller layer; defensive guard here).
   *
   * Returns the created user + the team id so the UI can navigate to it.
   */
  async createDrop(
    data: {
      email: string
      displayName: string
      telegram?: string | null
      phone?: string | null
      avatarUrl?: string | null
      techStack?: string[] | null
      dropSharePercent?: number
      paymentMethod?: 'USDT_ERC20' | 'BANK_UAH_FOP'
      walletUsdtErc20?: string | null
      walletUsdtLabel?: string | null
      bankUahRecipient?: string | null
      bankUahIban?: string | null
      bankUahRnokpp?: string | null
      bankUahBankName?: string | null
      /**
       * Legal full name (Cyrillic ФИО) for the drop's MSA contract. Required
       * at the schema/UI boundary; persisted here so it isn't lost.
       */
      legalFullName?: string | null
      /** Ukrainian registration address (ФОП) — optional; persisted when set. */
      registrationAddress?: string | null
      hrIds: string[]
      accountantId?: string | null
      telegramChannel?: string | null
    },
    actor: SessionUser,
  ): Promise<{ user: User; teamId: string }> {
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenException('Создание дропа доступно только администратору')
    }
    if (data.hrIds.length < 1) {
      throw new BadRequestException('HR обязателен (минимум 1)')
    }
    const existing = await this.findByEmail(data.email)
    if (existing) throw new ConflictException('Пользователь с таким email уже существует')

    return this.db.db.transaction(async (tx) => {
      const insertValues: typeof users.$inferInsert = {
        email: data.email,
        displayName: data.displayName,
        role: 'DROP',
        telegram: data.telegram ?? null,
        phone: data.phone ?? null,
        // Same rationale as UsersService.createUser — no dicebear placeholder.
        avatarUrl: data.avatarUrl ?? null,
        techStack: data.techStack ?? null,
        dropSharePercent: data.dropSharePercent ?? 5,
      }
      // Contract data — persist the legal ФИО / registration address so the
      // drop's MSA contract renders them (buildContractVariableMap reads both).
      // Trim + only set when non-blank, mirroring createUser.
      if (data.legalFullName?.trim()) insertValues.legalFullName = data.legalFullName.trim()
      if (data.registrationAddress?.trim())
        insertValues.registrationAddress = data.registrationAddress.trim()
      if (data.paymentMethod) {
        insertValues.paymentMethod = data.paymentMethod
        if (data.paymentMethod === 'USDT_ERC20') {
          insertValues.walletUsdtErc20 = data.walletUsdtErc20 ?? null
          insertValues.walletUsdtLabel = data.walletUsdtLabel ?? null
        } else {
          insertValues.bankUahRecipient = data.bankUahRecipient ?? null
          insertValues.bankUahIban = data.bankUahIban ?? null
          insertValues.bankUahRnokpp = data.bankUahRnokpp ?? null
          insertValues.bankUahBankName = data.bankUahBankName ?? null
        }
      }

      const rows = await tx.insert(users).values(insertValues).returning()
      const created = rows[0]
      if (!created) throw new Error('Failed to create drop user')

      await this.auditLogService.record(
        {
          actorId: actor.id,
          targetId: created.id,
          action: 'profile_created',
          changes: {
            displayName: { before: null, after: created.displayName },
            role: { before: null, after: created.role },
          },
        },
        tx,
      )

      const team = await this.teamsService.createDropTeam(
        created.id,
        data.hrIds,
        data.accountantId ?? null,
        data.telegramChannel ?? null,
        tx,
      )
      await this.teamAuditLogService.record(
        {
          actorId: actor.id,
          targetId: team.id,
          action: 'team_created',
          changes: { name: { before: null, after: team.name } },
        },
        tx,
      )

      return { user: created, teamId: team.id }
    })
  }

  /**
   * Soft-archive a DROP user with the full cascade:
   *  - Drop-team → archived (HR/Accountant detached).
   *  - Drop-projects → archived (project_members.leftAt set).
   *  - Active SENIOR (if any) → DETACHED from team_members but user row
   *    stays active. Becomes "teamless"; controller layer guards their
   *    sensitive endpoints (interviews → 403, projects → empty).
   *
   * Returns `{ archivedProjects, detachedSeniorId }` for UI confirmation.
   * RBAC: ADMIN only (enforced in controller; defensive guard here).
   */
  async archiveDrop(
    dropId: string,
    actor: SessionUser,
  ): Promise<{ archivedProjects: number; detachedSeniorId: string | null }> {
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenException('Архивация дропа доступна только администратору')
    }
    return this.db.db.transaction(async (tx) => {
      const user = await tx
        .select()
        .from(users)
        .where(eq(users.id, dropId))
        .then((rows) => rows[0])
      if (!user) throw new NotFoundException('Пользователь не найден')
      if (user.role !== 'DROP') {
        throw new BadRequestException('Метод доступен только для DROP')
      }
      if (user.archivedAt) throw new BadRequestException('Дроп уже архивирован')

      const dropMembership = await tx
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, dropId), isNull(teamMembers.leftAt)))
        .then((rows) => rows[0])

      let result = { archivedProjects: 0, detachedSeniorId: null as string | null }
      if (dropMembership) {
        result = await this.teamsService.archiveDropTeam(dropMembership.teamId, tx)
      }

      const now = new Date()
      await tx.update(users).set({ archivedAt: now, updatedAt: now }).where(eq(users.id, dropId))

      await this.auditLogService.record(
        {
          actorId: actor.id,
          targetId: dropId,
          action: 'user_archived',
          changes: { archivedAt: { before: null, after: now.toISOString() } },
        },
        tx,
      )

      return result
    })
  }

  /**
   * Rejoin-team primitive for a teamless SENIOR. Either creates a fresh
   * senior-team (`CREATE_NEW`) or attaches to an existing drop-team
   * (`JOIN_DROP_TEAM`). Caller must be the senior themselves (controller
   * enforces that the path is `me`).
   */
  async rejoinTeam(
    seniorId: string,
    data: {
      teamMode: 'CREATE_NEW' | 'JOIN_DROP_TEAM'
      dropTeamId?: string
      hrIds?: string[]
      accountantId?: string | null
    },
  ): Promise<{ teamId: string }> {
    const user = await this.findById(seniorId)
    if (!user) throw new NotFoundException('Пользователь не найден')
    if (user.role !== 'SENIOR') {
      throw new BadRequestException('Rejoin-team доступен только для SENIOR')
    }
    // Caller must currently have NO active team membership.
    const activeMembership = await this.db.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (activeMembership) {
      throw new BadRequestException('У вас уже есть активная команда')
    }

    if (data.teamMode === 'JOIN_DROP_TEAM') {
      if (!data.dropTeamId) {
        throw new BadRequestException('dropTeamId обязателен при teamMode=JOIN_DROP_TEAM')
      }
      await this.teamsService.addSeniorToDropTeam(data.dropTeamId, seniorId)
      return { teamId: data.dropTeamId }
    }

    // CREATE_NEW path — mirrors createUser SENIOR branch.
    if (!data.hrIds || data.hrIds.length < 1) {
      throw new BadRequestException('HR обязателен (минимум 1) при teamMode=CREATE_NEW')
    }
    return this.db.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(teams)
        .values({ name: `Команда ${user.displayName}` })
        .returning()
      const team = inserted[0]
      if (!team) throw new Error('Failed to create senior team')
      const memberIds = [
        seniorId,
        ...data.hrIds!,
        ...(data.accountantId ? [data.accountantId] : []),
      ]
      for (const userId of memberIds) {
        await tx.insert(teamMembers).values({ teamId: team.id, userId })
      }
      return { teamId: team.id }
    })
  }

  /**
   * Returns `true` if the user has an active team membership. Used by
   * controller layer to guard SENIOR endpoints (interviews / projects).
   */
  async userHasActiveTeam(userId: string): Promise<boolean> {
    const row = await this.db.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, userId), isNull(teamMembers.leftAt)))
      .limit(1)
      .then((rows) => rows[0])
    return Boolean(row)
  }

  /**
   * Returns salary metadata for the currently authenticated user (self-only).
   * changedAt = created_at of the most recent user_audit_log row where
   * target_id = userId AND changes JSONB contains 'monthlySalary' key.
   * Values in changes are redacted (SENSITIVE_FIELDS) — only the date is needed.
   *
   * AC3/4: used by JUNIOR hub salary block.
   */
  async getSalaryMeta(userId: string): Promise<{
    monthlySalary: string | null
    salaryCurrency: string | null
    changedAt: string | null
  }> {
    const userRow = await this.db.db
      .select({ monthlySalary: users.monthlySalary, salaryCurrency: users.salaryCurrency })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    const user = userRow[0]
    if (!user) return { monthlySalary: null, salaryCurrency: null, changedAt: null }

    // Find the most recent audit log entry where monthlySalary was changed.
    // changes is JSONB — use raw sql for the ? key-existence operator.
    const auditRows = await this.db.db
      .select({ createdAt: userAuditLog.createdAt })
      .from(userAuditLog)
      .where(
        and(
          eq(userAuditLog.targetId, userId),
          // jsonb_exists(col, key) checks for top-level key existence in JSONB.
          // Using the function form instead of the ? operator avoids issues with
          // pg parameterized-query escaping of the ? character.
          sql`jsonb_exists(${userAuditLog.changes}, 'monthlySalary')`,
        ),
      )
      .orderBy(desc(userAuditLog.createdAt))
      .limit(1)

    return {
      monthlySalary: user.monthlySalary ?? null,
      salaryCurrency: user.salaryCurrency ?? null,
      changedAt: auditRows[0]?.createdAt.toISOString() ?? null,
    }
  }
}
