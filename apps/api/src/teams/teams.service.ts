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
import {
  projectMembers,
  projects,
  teamMembers,
  teams,
  users,
} from '../database/schema'
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

  private mapTeam(team: TeamWithMembers, allProjects: ProjectWithMembers[], currentUser?: SessionUser) {
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
          if (
            pm.leftAt === null &&
            pm.user?.role === 'JUNIOR' &&
            !seenJuniorIds.has(pm.userId)
          ) {
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

  private isHrOfTeam(team: TeamWithMembers, userId: string) {
    return team.members.some((m) => m.userId === userId && m.user?.role === 'HR')
  }

  private async fetchAllProjects(): Promise<ProjectWithMembers[]> {
    return this.db.db.query.projects.findMany({
      with: { members: { with: { user: true } } },
    }) as Promise<ProjectWithMembers[]>
  }

  async create(name: string, seniorId: string, hrIds: string[], accountantId: string | null, currentUser: SessionUser) {
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
    const seniorRow = await this.db.db
      .select({ id: users.id, displayName: users.displayName })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (!seniorRow) {
      return {
        type: 'team',
        isPaired: true,
        teamName: team.name,
        seniorName: '',
        projectsCount: 0,
        membersAffected: 0,
      }
    }
    const userImpact = await this.usersService.getArchiveImpact(seniorRow.id)
    const seniorImpact = userImpact.type === 'user' && userImpact.role === 'SENIOR' ? userImpact : null
    return {
      type: 'team',
      isPaired: true,
      teamName: team.name,
      seniorName: seniorRow.displayName,
      projectsCount: seniorImpact?.projectsCount ?? 0,
      membersAffected: seniorImpact?.hrAccountantsToBeRemoved ?? 0,
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
      throw new BadRequestException('Cannot remove the senior from a team — delete the team instead')
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

  private assertAccess(team: TeamWithMembers, currentUser: SessionUser, allProjects: ProjectWithMembers[]) {
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
}
