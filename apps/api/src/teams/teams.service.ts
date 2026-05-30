import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { ArchiveImpact, SessionUser } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { projectMembers, projects, teamMembers, teams, users } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { UsersService } from '../users/users.service'

type TeamWithMembers = typeof teams.$inferSelect & {
  members: Array<typeof teamMembers.$inferSelect & { user: typeof users.$inferSelect | null }>
}

type ProjectWithMembers = typeof projects.$inferSelect & {
  members: Array<typeof projectMembers.$inferSelect & { user: typeof users.$inferSelect | null }>
}

@Injectable()
export class TeamsService {
  constructor(
    private db: DatabaseService,
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
  ) {}

  private mapTeam(
    team: TeamWithMembers,
    allProjects: ProjectWithMembers[],
    currentUser?: SessionUser,
  ) {
    // Drop role - phase 1: early return for drop-teams keeps the legacy
    // senior-team branch (below) byte-for-byte identical.
    if (team.type === 'DROP') {
      return this.mapDropTeam(team)
    }

    const senior = team.members.find((m) => m.user?.role === 'SENIOR')

    const juniorMembers: Array<{
      id: string
      userId: string
      displayName: string
      email: string
      avatarUrl: string | null
      avatarDocumentId: string | null
      techStack: string[] | null
      phone: string | null
      telegram: string | null
      role: string
      joinedAt: string | Date
    }> = []

    if (senior) {
      const seniorProjects = allProjects.filter((p) => p.seniorId === senior.userId)
      const seenJuniorIds = new Set<string>()
      for (const project of seniorProjects) {
        for (const pm of project.members) {
          if (pm.leftAt === null && pm.user?.role === 'JUNIOR' && !seenJuniorIds.has(pm.userId)) {
            seenJuniorIds.add(pm.userId)
            juniorMembers.push({
              id: pm.id,
              userId: pm.userId,
              displayName: pm.user.displayName,
              email: pm.user.email,
              avatarUrl: pm.user.avatarUrl ?? null,
              avatarDocumentId: pm.user.avatarDocumentId ?? null,
              techStack: pm.user.techStack ?? null,
              phone: pm.user.phone ?? null,
              telegram: pm.user.telegram ?? null,
              role: 'JUNIOR',
              joinedAt: pm.joinedAt.toISOString(),
            })
          }
        }
      }
    }

    // Filter out other JUNIORs if the current user is a JUNIOR
    let filteredJuniorMembers = juniorMembers
    if (currentUser?.role === 'JUNIOR') {
      filteredJuniorMembers = juniorMembers.filter((j) => j.userId === currentUser.id)
    }

    return {
      id: team.id,
      name: team.name,
      type: team.type,
      telegram: team.telegram ?? null,
      telegramChannel: team.telegramChannel ?? null,
      notes: team.notes ?? null,
      archivedAt: team.archivedAt ? team.archivedAt.toISOString() : null,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      members: [
        ...team.members
          .filter((m) => m.user?.role !== 'ADMIN' && m.user?.role !== 'JUNIOR' && m.leftAt === null)
          .map((m) => ({
            id: m.id,
            userId: m.userId,
            displayName: m.user?.displayName ?? '',
            email: m.user?.email ?? '',
            avatarUrl: m.user?.avatarUrl ?? null,
            avatarDocumentId: m.user?.avatarDocumentId ?? null,
            techStack: m.user?.techStack ?? null,
            phone: m.user?.phone ?? null,
            telegram: m.user?.telegram ?? null,
            role: m.user?.role ?? 'SENIOR',
            joinedAt: m.joinedAt,
            leftAt: m.leftAt ? m.leftAt.toISOString() : null,
          })),
        ...filteredJuniorMembers,
      ],
    }
  }

  /**
   * Drop-team variant: returns DROP owner + active SENIOR (if any) + HR(s)
   * + accountant. JUNIORs are NOT computed via project_members (drop-teams
   * don't propagate juniors through the senior — Phase 2 will add the
   * drop-project distribution; for now juniors remain a senior-team
   * concept only).
   */
  private mapDropTeam(team: TeamWithMembers) {
    const activeMembers = team.members.filter(
      (m) => m.leftAt === null && m.user?.role !== 'ADMIN' && m.user?.role !== 'JUNIOR',
    )
    return {
      id: team.id,
      name: team.name,
      type: team.type,
      telegram: team.telegram ?? null,
      telegramChannel: team.telegramChannel ?? null,
      notes: team.notes ?? null,
      archivedAt: team.archivedAt ? team.archivedAt.toISOString() : null,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      members: activeMembers.map((m) => ({
        id: m.id,
        userId: m.userId,
        displayName: m.user?.displayName ?? '',
        email: m.user?.email ?? '',
        avatarUrl: m.user?.avatarUrl ?? null,
        avatarDocumentId: m.user?.avatarDocumentId ?? null,
        techStack: m.user?.techStack ?? null,
        phone: m.user?.phone ?? null,
        telegram: m.user?.telegram ?? null,
        role: m.user?.role ?? 'DROP',
        joinedAt: m.joinedAt,
        leftAt: m.leftAt ? m.leftAt.toISOString() : null,
      })),
    }
  }

  private isHrOfTeam(team: TeamWithMembers, userId: string) {
    return team.members.some((m) => m.userId === userId && m.user?.role === 'HR')
  }

  private async fetchAllProjects(): Promise<ProjectWithMembers[]> {
    return this.db.db.query.projects.findMany({
      with: { members: { with: { user: true } } },
    }) as Promise<ProjectWithMembers[]>
  }

  async create(
    name: string,
    seniorId: string,
    hrIds: string[],
    accountantId: string | null,
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }

    const [team] = await this.db.db.insert(teams).values({ name }).returning()
    if (!team) throw new Error('Failed to create team')

    const memberIds = [seniorId, ...hrIds, ...(accountantId ? [accountantId] : [])]
    for (const userId of memberIds) {
      await this.db.db.insert(teamMembers).values({ teamId: team.id, userId })
    }

    return team
  }

  async findAll(currentUser: SessionUser, filter: { archived?: boolean | 'all' } = {}) {
    // round 7 (ut-44): tri-state filter — `'all'` returns both active and
    // archived teams (used by the «Все» tab); boolean keeps the legacy behavior.
    const archivedWhere =
      filter.archived === 'all'
        ? undefined
        : filter.archived === true
          ? isNotNull(teams.archivedAt)
          : isNull(teams.archivedAt)
    const [allTeams, allProjects] = await Promise.all([
      this.db.db.query.teams.findMany({
        ...(archivedWhere ? { where: archivedWhere } : {}),
        with: { members: { with: { user: true } } },
      }),
      this.fetchAllProjects(),
    ])

    let filtered = allTeams
    if (currentUser.role === 'HR') {
      filtered = allTeams.filter((t) => this.isHrOfTeam(t, currentUser.id))
    } else if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      // SENIOR/JUNIOR: show teams where they are a static member
      // For JUNIORs derived from projects, also include teams where their senior is
      filtered = allTeams.filter((t) => {
        if (t.members.some((m) => m.userId === currentUser.id)) return true
        if (currentUser.role === 'JUNIOR') {
          // Check if this team's senior has an active project with this junior
          const senior = t.members.find((m) => m.user?.role === 'SENIOR')
          if (senior) {
            const seniorProjects = allProjects.filter((p) => p.seniorId === senior.userId)
            return seniorProjects.some((p) =>
              p.members.some((m) => m.userId === currentUser.id && m.leftAt === null),
            )
          }
        }
        return false
      })
    }

    return filtered.map((t) => this.mapTeam(t, allProjects, currentUser))
  }

  async findOne(id: string, currentUser: SessionUser) {
    const [team, allProjects] = await Promise.all([
      this.db.db.query.teams.findFirst({
        where: eq(teams.id, id),
        with: { members: { with: { user: true } } },
      }),
      this.fetchAllProjects(),
    ])
    if (!team) throw new NotFoundException('Team not found')
    this.assertAccess(team, currentUser, allProjects)
    return this.mapTeam(team, allProjects, currentUser)
  }

  async update(
    id: string,
    name: string,
    telegram: string | null | undefined,
    notes: string | null | undefined,
    currentUser: SessionUser,
    telegramChannel?: string | null | undefined,
  ) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }

    const team = await this.db.db.query.teams.findFirst({
      where: eq(teams.id, id),
      with: { members: { with: { user: true } } },
    })
    if (!team) throw new NotFoundException('Team not found')

    if (currentUser.role === 'HR' && !this.isHrOfTeam(team, currentUser.id)) {
      throw new ForbiddenException()
    }

    const [updated] = await this.db.db
      .update(teams)
      .set({
        name,
        ...(telegram !== undefined ? { telegram } : {}),
        ...(telegramChannel !== undefined ? { telegramChannel } : {}),
        ...(notes !== undefined ? { notes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(teams.id, id))
      .returning()

    return updated
  }

  /**
   * Soft-archive a team. By business invariant, archiving the team is equivalent
   * to archiving its SENIOR — the two are inseparable. We delegate to
   * UsersService.archive(team.seniorId) which performs the pair-cascade
   * (archive senior + projects + remove HR/Acc team_members).
   */
  async archive(teamId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    const team = await this.db.db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      with: { members: { with: { user: true } } },
    })
    if (!team) throw new NotFoundException('Team not found')
    if (team.archivedAt) throw new BadRequestException('Team is already archived')

    // Drop-archive round 2 (B1): dispatch by team type. Drop-teams use the
    // dedicated `archiveDropTeam` primitive (drop archived + projects
    // cascade + HR/Acc detached + senior detached *without* archiving).
    // Senior-teams keep the existing pair-cascade through UsersService.
    if (team.type === 'DROP') {
      await this.archiveDropTeam(teamId)
      return this.findOne(teamId, currentUser)
    }

    const seniorMember = team.members.find((m) => m.user?.role === 'SENIOR' && m.leftAt === null)
    if (!seniorMember) {
      throw new BadRequestException('Team has no active SENIOR — cannot archive via pair flow')
    }
    await this.usersService.archive(seniorMember.userId, currentUser.id)
    return this.findOne(teamId, currentUser)
  }

  /**
   * Pair-unarchive: restore SENIOR + team. Projects remain archived;
   * HR/Acc memberships remain closed (admin re-adds via Teams page).
   */
  async unarchive(teamId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    const team = await this.db.db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      with: { members: true },
    })
    if (!team) throw new NotFoundException('Team not found')
    if (!team.archivedAt) throw new BadRequestException('Team is not archived')

    // Find SENIOR via team_members + users join — `with: { members: true }`
    // above doesn't include user.role, so we run a focused lookup here.
    const seniorRow = await this.db.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR')))
      .then((rows) => rows[0])
    if (!seniorRow) {
      throw new NotFoundException('Senior of this team not found')
    }
    await this.usersService.unarchive(seniorRow.userId, currentUser.id)
    return this.findOne(teamId, currentUser)
  }

  /**
   * Returns the archive impact for the team (pair = senior). UI uses for warnings.
   */
  async getArchiveImpact(teamId: string, currentUser: SessionUser): Promise<ArchiveImpact> {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    const team = await this.db.db.query.teams.findFirst({
      where: eq(teams.id, teamId),
    })
    if (!team) throw new NotFoundException('Team not found')

    // Drop-archive round 2 (B2): branch by team type. Drop-teams have a
    // different "paired" entity — the drop (not a senior). UI keys on
    // `teamType` to render the right copy + confirm-input.
    if (team.type === 'DROP') {
      // Resolve the drop owner (paired user for the confirmation text).
      const dropRow = await this.db.db
        .select({ id: users.id, displayName: users.displayName })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(eq(teamMembers.teamId, teamId), eq(users.role, 'DROP'), isNull(teamMembers.leftAt)),
        )
        .then((rows) => rows[0])
      // Active senior (informational only — gets detached without archive).
      const seniorRow = await this.db.db
        .select({ id: users.id, displayName: users.displayName })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)),
        )
        .then((rows) => rows[0])
      // Active HR/Accountant count — all will be detached (leftAt=now) by
      // `archiveDropTeam`. Computed cheaply with a single query excluding
      // the drop + senior rows.
      const others = await this.db.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(eq(teamMembers.teamId, teamId), isNull(teamMembers.leftAt), eq(users.role, 'HR')),
        )
      const accountants = await this.db.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            isNull(teamMembers.leftAt),
            eq(users.role, 'ACCOUNTANT'),
          ),
        )
      // Drop-projects count.
      const dropProjects = dropRow
        ? await this.db.db
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.dropId, dropRow.id), isNull(projects.archivedAt)))
        : []
      return {
        type: 'team',
        isPaired: true,
        teamName: team.name,
        // Keep `seniorName` for legacy clients — empty if no senior attached.
        // The new `dropName` field is what the v2 UI keys on.
        seniorName: seniorRow?.displayName ?? '',
        projectsCount: dropProjects.length,
        membersAffected: others.length + accountants.length,
        teamType: 'DROP',
        dropName: dropRow?.displayName ?? '',
        seniorWillBeDetached: !!seniorRow,
      }
    }

    // SENIOR team — legacy path (unchanged 1:1 from round 1).
    const seniorRow = await this.db.db
      .select({ id: users.id, displayName: users.displayName })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)),
      )
      .then((rows) => rows[0])
    if (!seniorRow) {
      return {
        type: 'team',
        isPaired: true,
        teamName: team.name,
        seniorName: '',
        projectsCount: 0,
        membersAffected: 0,
        teamType: 'SENIOR',
      }
    }
    const userImpact = await this.usersService.getArchiveImpact(seniorRow.id)
    const seniorImpact =
      userImpact.type === 'user' && userImpact.role === 'SENIOR' ? userImpact : null
    return {
      type: 'team',
      isPaired: true,
      teamName: team.name,
      seniorName: seniorRow.displayName,
      projectsCount: seniorImpact?.projectsCount ?? 0,
      membersAffected: seniorImpact?.hrAccountantsToBeRemoved ?? 0,
      teamType: 'SENIOR',
    }
  }

  async addMember(teamId: string, userId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }

    const team = await this.db.db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      with: { members: { with: { user: true } } },
    })
    if (!team) throw new NotFoundException('Team not found')

    if (currentUser.role === 'HR' && !this.isHrOfTeam(team, currentUser.id)) {
      throw new ForbiddenException()
    }

    const user = await this.db.db.query.users.findFirst({ where: eq(users.id, userId) })
    if (!user) throw new NotFoundException('User not found')
    if (user.role === 'ADMIN') throw new BadRequestException('Admin cannot be a team member')

    // Prevent adding a second SENIOR
    if (user.role === 'SENIOR') {
      const hasSenior = team.members.some((m) => m.user?.role === 'SENIOR')
      if (hasSenior) throw new BadRequestException('Team already has a senior')
    }

    // Prevent adding a JUNIOR who has an active project
    if (user.role === 'JUNIOR') {
      const allProjects = await this.fetchAllProjects()
      const hasActiveProject = allProjects.some((p) =>
        p.members.some((m) => m.userId === userId && m.leftAt === null),
      )
      if (hasActiveProject) throw new BadRequestException('Junior already has an active project')
    }

    const existing = await this.db.db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
    })
    if (existing) throw new BadRequestException('User is already a member')

    await this.db.db.insert(teamMembers).values({ teamId, userId })
  }

  async removeMember(teamId: string, userId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }

    const team = await this.db.db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      with: { members: { with: { user: true } } },
    })
    if (!team) throw new NotFoundException('Team not found')

    if (currentUser.role === 'HR' && !this.isHrOfTeam(team, currentUser.id)) {
      throw new ForbiddenException()
    }

    const memberToRemove = team.members.find((m) => m.userId === userId)
    if (!memberToRemove) throw new NotFoundException('Member not found in team')

    const removedRole = memberToRemove.user?.role
    if (removedRole === 'SENIOR') {
      throw new BadRequestException(
        'Cannot remove the senior from a team — delete the team instead',
      )
    }

    if (removedRole === 'HR') {
      const hrCount = team.members.filter((m) => m.user?.role === 'HR').length
      if (hrCount <= 1) {
        throw new BadRequestException('Team must have at least one HR')
      }
    }

    if (removedRole === 'ACCOUNTANT') {
      const accountantCount = team.members.filter((m) => m.user?.role === 'ACCOUNTANT').length
      if (accountantCount <= 1) {
        throw new BadRequestException('Team must have at least one accountant')
      }
    }

    await this.db.db
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
  }

  private assertAccess(
    team: TeamWithMembers,
    currentUser: SessionUser,
    allProjects: ProjectWithMembers[],
  ) {
    if (currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT') return
    if (team.members.some((m) => m.userId === currentUser.id)) return

    // For JUNIORs: check if they have an active project with this team's senior
    if (currentUser.role === 'JUNIOR') {
      const senior = team.members.find((m) => m.user?.role === 'SENIOR')
      if (senior) {
        const seniorProjects = allProjects.filter((p) => p.seniorId === senior.userId)
        const hasActiveProjectWithSenior = seniorProjects.some((p) =>
          p.members.some((m) => m.userId === currentUser.id && m.leftAt === null),
        )
        if (hasActiveProjectWithSenior) return
      }
    }

    throw new ForbiddenException()
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Drop role - phase 1: drop-team primitives
  //
  // Strictly additive. The legacy senior-team methods above (`create`,
  // `archive`, `addMember`, `removeMember`, `mapTeam` SENIOR branch) are
  // UNCHANGED. All drop-team behavior lives in the methods below.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Helper for asserting that a user has the expected role, surfacing
   * a 400 instead of an opaque 500.
   */
  private async assertUserRole(
    userId: string,
    expectedRole: 'DROP' | 'SENIOR' | 'HR' | 'ACCOUNTANT',
    tx?: DrizzleTx,
  ): Promise<void> {
    const handle = tx ?? this.db.db
    const u = await handle
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .then((rows) => rows[0])
    if (!u) throw new BadRequestException(`Пользователь ${userId} не найден`)
    if (u.role !== expectedRole) {
      throw new BadRequestException(`Ожидалась роль ${expectedRole}, получено ${u.role}`)
    }
  }

  /**
   * Create a drop-team for an existing DROP user. Used by
   * `UsersService.createDrop` inside a single transaction so the DROP user
   * insert + team creation either commit together or roll back together.
   *
   * Validations:
   *  - `dropId.role === 'DROP'`
   *  - `hrIds.length >= 1` and every hrId has `role === 'HR'`
   *  - `accountantId.role === 'ACCOUNTANT'`
   *
   * Telegram channel is stored on `teams.telegram_channel` (column already
   * exists from 0007). No standalone `telegram` field on the drop-team —
   * spec keeps that for senior-team comms only.
   */
  async createDropTeam(
    dropId: string,
    hrIds: string[],
    accountantId: string,
    telegramChannel: string | null,
    tx?: DrizzleTx,
  ): Promise<typeof teams.$inferSelect> {
    if (hrIds.length < 1) {
      throw new BadRequestException('HR обязателен (минимум 1)')
    }
    const handle = tx ?? this.db.db
    await this.assertUserRole(dropId, 'DROP', tx)
    for (const hrId of hrIds) await this.assertUserRole(hrId, 'HR', tx)
    await this.assertUserRole(accountantId, 'ACCOUNTANT', tx)

    const dropUser = await handle
      .select()
      .from(users)
      .where(eq(users.id, dropId))
      .then((rows) => rows[0])
    if (!dropUser) throw new BadRequestException('Дроп не найден')

    const inserted = await handle
      .insert(teams)
      .values({
        name: `Команда ${dropUser.displayName}`,
        type: 'DROP',
        telegramChannel: telegramChannel ?? null,
      })
      .returning()
    const team = inserted[0]
    if (!team) throw new Error('Failed to create drop team')

    const memberIds = [dropId, ...hrIds, accountantId]
    for (const userId of memberIds) {
      await handle.insert(teamMembers).values({ teamId: team.id, userId })
    }
    return team
  }

  /**
   * Archive a drop-team. Caller is `UsersService.archiveDrop` (drop-user
   * archive cascade) or a future explicit `DELETE /api/teams/:id` endpoint
   * for drop-teams.
   *
   * Cascades (per spec §7):
   *  - Drop-projects of this team's drop → `archivedAt=now()`.
   *  - Active SENIOR in this team → `team_members.leftAt=now()`. SENIOR is
   *    NOT archived (their user row stays active; they become teamless).
   *  - HR + ACCOUNTANT in this team → `leftAt=now()`.
   *  - `teams.archivedAt=now()`.
   *
   * Returns `{ archivedProjects, detachedSeniorId }` so the UI can render
   * a confirmation toast.
   */
  async archiveDropTeam(
    teamId: string,
    tx?: DrizzleTx,
  ): Promise<{ archivedProjects: number; detachedSeniorId: string | null }> {
    const handle = tx ?? this.db.db
    const team = await handle
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .then((rows) => rows[0])
    if (!team) throw new NotFoundException('Команда не найдена')
    if (team.type !== 'DROP') {
      throw new BadRequestException('Метод доступен только для drop-команд')
    }
    if (team.archivedAt) throw new BadRequestException('Команда уже архивирована')

    const now = new Date()
    // Resolve the drop owner (DROP member of this team).
    const dropMember = await handle
      .select({ userId: teamMembers.userId, role: users.role })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(eq(teamMembers.teamId, teamId), eq(users.role, 'DROP'), isNull(teamMembers.leftAt)),
      )
      .then((rows) => rows[0])
    const dropId = dropMember?.userId ?? null

    // Detach the active SENIOR (if any) — leftAt=now, user row untouched.
    const seniorMember = await handle
      .select({ id: teamMembers.id, userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)),
      )
      .then((rows) => rows[0])
    const detachedSeniorId = seniorMember?.userId ?? null
    if (seniorMember) {
      await handle
        .update(teamMembers)
        .set({ leftAt: now })
        .where(eq(teamMembers.id, seniorMember.id))
    }

    // Archive drop-projects (projects.dropId === this team's drop user)
    let archivedProjects = 0
    if (dropId) {
      const dropProjects = await handle
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.dropId, dropId), isNull(projects.archivedAt)))
      for (const p of dropProjects) {
        await handle
          .update(projects)
          .set({ archivedAt: now, updatedAt: now })
          .where(eq(projects.id, p.id))
        // Cascade: detach active project_members.
        await handle
          .update(projectMembers)
          .set({ leftAt: now })
          .where(and(eq(projectMembers.projectId, p.id), isNull(projectMembers.leftAt)))
        archivedProjects += 1
      }
    }

    // Detach HR/Accountant — leftAt=now on remaining active rows except SENIOR (already done).
    await handle
      .update(teamMembers)
      .set({ leftAt: now })
      .where(and(eq(teamMembers.teamId, teamId), isNull(teamMembers.leftAt)))

    await handle.update(teams).set({ archivedAt: now, updatedAt: now }).where(eq(teams.id, teamId))

    return { archivedProjects, detachedSeniorId }
  }

  /**
   * Rotate the active SENIOR of a drop-team. Caller is ADMIN or an HR of
   * this team (RBAC check below). The new senior cannot already be in
   * another active team — caller must archive/detach first. The current
   * active senior (if any) gets `leftAt=now()`; the new senior is added
   * as a member. DROP stays.
   */
  async rotateSenior(
    teamId: string,
    newSeniorId: string,
    currentUser: SessionUser,
  ): Promise<typeof teams.$inferSelect> {
    return this.db.db.transaction(async (tx) => {
      const team = await tx
        .select()
        .from(teams)
        .where(eq(teams.id, teamId))
        .then((rows) => rows[0])
      if (!team) throw new NotFoundException('Команда не найдена')
      if (team.type !== 'DROP') {
        throw new BadRequestException('Ротация синьора доступна только для drop-команд')
      }
      if (team.archivedAt) throw new BadRequestException('Команда архивирована')

      // RBAC: ADMIN or HR of this team.
      if (currentUser.role !== 'ADMIN') {
        if (currentUser.role !== 'HR') throw new ForbiddenException()
        const isHrHere = await tx
          .select()
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, teamId),
              eq(teamMembers.userId, currentUser.id),
              isNull(teamMembers.leftAt),
            ),
          )
          .then((rows) => rows[0])
        if (!isHrHere) throw new ForbiddenException()
      }

      await this.assertUserRole(newSeniorId, 'SENIOR', tx)

      // Reject if new senior already has an active team membership.
      const otherMembership = await tx
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, newSeniorId), isNull(teamMembers.leftAt)))
        .then((rows) => rows[0])
      if (otherMembership) {
        throw new BadRequestException('Синьор уже состоит в другой активной команде')
      }

      const now = new Date()
      // Detach current senior if present.
      const currentSenior = await tx
        .select({ id: teamMembers.id, userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)),
        )
        .then((rows) => rows[0])
      if (currentSenior) {
        await tx
          .update(teamMembers)
          .set({ leftAt: now })
          .where(eq(teamMembers.id, currentSenior.id))
      }

      await tx.insert(teamMembers).values({ teamId, userId: newSeniorId })
      const updated = await tx
        .update(teams)
        .set({ updatedAt: now })
        .where(eq(teams.id, teamId))
        .returning()
      return updated[0]!
    })
  }

  /**
   * Attach an existing SENIOR (with no active team) to a drop-team that has
   * no active senior. Used by:
   *  - the create-senior flow with `teamMode='JOIN_DROP_TEAM'`
   *  - the rejoin-team endpoint for an orphaned senior
   *  - a future standalone "assign senior" action on the drop-team page
   *
   * Validations:
   *  - team exists, `type='DROP'`, not archived
   *  - team has no active senior
   *  - senior exists, `role='SENIOR'`, has no other active team membership
   *
   * RBAC is delegated to callers (createUser, rejoin-team controller, etc.)
   * because this primitive is reused from several entry points. The `tx`
   * arg is supplied when callers want atomicity with their outer flow.
   */
  async addSeniorToDropTeam(teamId: string, seniorId: string, tx?: DrizzleTx): Promise<void> {
    const handle = tx ?? this.db.db
    const team = await handle
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .then((rows) => rows[0])
    if (!team) throw new NotFoundException('Команда не найдена')
    if (team.type !== 'DROP') {
      throw new BadRequestException('Метод доступен только для drop-команд')
    }
    if (team.archivedAt) throw new BadRequestException('Команда архивирована')

    await this.assertUserRole(seniorId, 'SENIOR', tx)

    const existingSenior = await handle
      .select()
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)),
      )
      .then((rows) => rows[0])
    if (existingSenior) {
      throw new BadRequestException('В команде уже есть активный синьор')
    }

    const otherMembership = await handle
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (otherMembership) {
      throw new BadRequestException('Синьор уже состоит в другой активной команде')
    }

    await handle.insert(teamMembers).values({ teamId, userId: seniorId })
  }
}
