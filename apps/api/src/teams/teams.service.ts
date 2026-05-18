import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  projectMembers,
  projects,
  teamMembers,
  teams,
  users,
} from '../database/schema'

type TeamWithMembers = typeof teams.$inferSelect & {
  members: Array<typeof teamMembers.$inferSelect & { user: typeof users.$inferSelect | null }>
}

type ProjectWithMembers = typeof projects.$inferSelect & {
  members: Array<typeof projectMembers.$inferSelect & { user: typeof users.$inferSelect | null }>
}

@Injectable()
export class TeamsService {
  constructor(private db: DatabaseService) {}

  private mapTeam(team: TeamWithMembers, allProjects: ProjectWithMembers[], currentUser?: SessionUser) {
    const senior = team.members.find((m) => m.user?.role === 'SENIOR')

    const juniorMembers: Array<{
      id: string
      userId: string
      displayName: string
      email: string
      avatar: string | null
      techStack: string | null
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
              avatar: pm.user.avatar ?? null,
              techStack: pm.user.techStack ?? null,
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
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      members: [
        ...team.members
          .filter((m) => m.user?.role !== 'ADMIN' && m.user?.role !== 'JUNIOR')
          .map((m) => ({
            id: m.id,
            userId: m.userId,
            displayName: m.user?.displayName ?? '',
            email: m.user?.email ?? '',
            avatar: m.user?.avatar ?? null,
            techStack: m.user?.techStack ?? null,
            role: m.user?.role ?? 'SENIOR',
            joinedAt: m.joinedAt,
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

  async findAll(currentUser: SessionUser) {
    const [allTeams, allProjects] = await Promise.all([
      this.db.db.query.teams.findMany({
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

  async update(id: string, name: string, currentUser: SessionUser) {
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
      .set({ name, updatedAt: new Date() })
      .where(eq(teams.id, id))
      .returning()

    return updated
  }

  async remove(id: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const team = await this.db.db.query.teams.findFirst({
      where: eq(teams.id, id),
      with: { members: { with: { user: true } } },
    })
    if (!team) throw new NotFoundException('Team not found')

    // Delete the team - FK cascades will handle team_members removal
    // The senior user remains in the database and can be assigned to other teams
    await this.db.db.delete(teams).where(eq(teams.id, id))
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
