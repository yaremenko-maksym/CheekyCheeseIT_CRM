import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { CreateProjectDto, SessionUser, UpdateProjectDto } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  projectMembers,
  projects,
  teamMembers,
  users,
  type Interview,
  type Project,
  type ProjectMember,
  type User,
} from '../database/schema'

type ProjectWithRelations = Project & {
  senior: User | null
  members: Array<ProjectMember & { user: User | null }>
}

@Injectable()
export class ProjectsService {
  constructor(private db: DatabaseService) {}

  private mapProject(project: ProjectWithRelations) {
    return {
      id: project.id,
      name: project.name,
      companyName: project.companyName,
      domain: project.domain,
      logoUrl: project.logoUrl ?? null,
      startDate: project.startDate.toISOString(),
      endDate: project.endDate ? project.endDate.toISOString() : null,
      seniorId: project.seniorId,
      seniorName: project.senior?.displayName ?? '',
      rate: project.rate,
      currency: project.currency,
      status: project.status,
      techStack: project.techStack ?? null,
      teamSize: project.teamSize ?? null,
      benefits: project.benefits ?? null,
      paymentType: project.paymentType ?? null,
      salaryReview: project.salaryReview ?? null,
      corpTech: project.corpTech ?? null,
      notesGeneral: project.notesGeneral ?? null,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      members: project.members.map((m) => ({
        id: m.id,
        userId: m.userId,
        displayName: m.user?.displayName ?? '',
        email: m.user?.email ?? '',
        avatar: m.user?.avatar ?? null,
        role: m.user?.role ?? 'JUNIOR',
        joinedAt: m.joinedAt.toISOString(),
        leftAt: m.leftAt ? m.leftAt.toISOString() : null,
      })),
    }
  }

  private async getHrSeniorIds(hrId: string): Promise<string[]> {
    const hrTeams = await this.db.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, hrId))
    if (!hrTeams.length) return []
    const teamIds = hrTeams.map((r) => r.teamId)
    const seniors = await this.db.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(inArray(teamMembers.teamId, teamIds), eq(users.role, 'SENIOR')))
    return seniors.map((r) => r.userId)
  }

  async findAll(currentUser: SessionUser) {
    const allProjects = await this.db.db.query.projects.findMany({
      with: { senior: true, members: { with: { user: true } } },
    })

    let filtered = allProjects as ProjectWithRelations[]

    if (currentUser.role === 'SENIOR') {
      filtered = filtered.filter((p) => p.seniorId === currentUser.id)
    } else if (currentUser.role === 'HR') {
      const seniorIds = await this.getHrSeniorIds(currentUser.id)
      filtered = filtered.filter((p) => p.seniorId !== null && seniorIds.includes(p.seniorId))
    } else if (currentUser.role === 'JUNIOR') {
      filtered = filtered.filter((p) =>
        p.members.some((m) => m.userId === currentUser.id && m.leftAt === null),
      )
    }
    // ADMIN, ACCOUNTANT see all

    return filtered.map((p) => this.mapProject(p))
  }

  async findOne(id: string, currentUser: SessionUser) {
    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: { senior: true, members: { with: { user: true } } },
    }) as ProjectWithRelations | undefined

    if (!project) throw new NotFoundException('Project not found')
    await this.assertAccess(project, currentUser)
    return this.mapProject(project)
  }

  async create(data: CreateProjectDto, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }

    const senior = await this.db.db.query.users.findFirst({
      where: eq(users.id, data.seniorId),
    })
    if (!senior) throw new NotFoundException('Senior not found')
    if (senior.role !== 'SENIOR' && senior.role !== 'ADMIN') throw new BadRequestException('User is not a SENIOR or ADMIN')

    const [project] = await this.db.db
      .insert(projects)
      .values({
        name: data.name,
        companyName: data.companyName,
        domain: data.domain,
        logoUrl: data.logoUrl ?? null,
        startDate: new Date(data.startDate),
        seniorId: data.seniorId,
        rate: data.rate,
        currency: data.currency,
        status: 'ACTIVE',
        techStack: data.techStack ?? null,
        teamSize: data.teamSize ?? null,
        benefits: data.benefits ?? null,
        paymentType: data.paymentType ?? null,
        salaryReview: data.salaryReview ?? null,
        corpTech: data.corpTech ?? null,
        notesGeneral: data.notesGeneral ?? null,
      })
      .returning()

    const created = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, project!.id),
      with: { senior: true, members: { with: { user: true } } },
    }) as ProjectWithRelations

    return this.mapProject(created)
  }

  async update(
    id: string,
    data: UpdateProjectDto,
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: { senior: true, members: { with: { user: true } } },
    }) as ProjectWithRelations | undefined

    if (!project) throw new NotFoundException('Project not found')

    const updateData: Partial<typeof projects.$inferInsert> = {
      updatedAt: new Date(),
    }
    if (data.name !== undefined) updateData.name = data.name
    if (data.companyName !== undefined) updateData.companyName = data.companyName
    if (data.domain !== undefined) updateData.domain = data.domain
    if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl ?? null
    if (data.endDate !== undefined) updateData.endDate = data.endDate ? new Date(data.endDate) : null
    if (data.rate !== undefined) updateData.rate = data.rate
    if (data.currency !== undefined) updateData.currency = data.currency
    if (data.status !== undefined) updateData.status = data.status
    if (data.techStack !== undefined) updateData.techStack = data.techStack ?? null
    if (data.teamSize !== undefined) updateData.teamSize = data.teamSize ?? null
    if (data.benefits !== undefined) updateData.benefits = data.benefits ?? null
    if (data.paymentType !== undefined) updateData.paymentType = data.paymentType ?? null
    if (data.salaryReview !== undefined) updateData.salaryReview = data.salaryReview ?? null
    if (data.corpTech !== undefined) updateData.corpTech = data.corpTech ?? null
    if (data.notesGeneral !== undefined) updateData.notesGeneral = data.notesGeneral ?? null

    await this.db.db.update(projects).set(updateData).where(eq(projects.id, id))

    const updated = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: { senior: true, members: { with: { user: true } } },
    }) as ProjectWithRelations

    return this.mapProject(updated)
  }

  async remove(id: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
    })
    if (!project) throw new NotFoundException('Project not found')

    await this.db.db.delete(projects).where(eq(projects.id, id))
  }

  async addMember(projectId: string, userId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: { senior: true, members: { with: { user: true } } },
    }) as ProjectWithRelations | undefined

    if (!project) throw new NotFoundException('Project not found')

    const user = await this.db.db.query.users.findFirst({
      where: eq(users.id, userId),
    })
    if (!user) throw new NotFoundException('User not found')
    if (user.role !== 'JUNIOR' && user.role !== 'HR' && user.role !== 'ACCOUNTANT') {
      throw new BadRequestException('Only JUNIORs, HRs, and ACCOUNTANTs can be added as project members')
    }

    // Prevent duplicate active membership on same project
    const existingActive = await this.db.db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        isNull(projectMembers.leftAt),
      ),
    })
    if (existingActive) throw new BadRequestException('User is already an active member of this project')

    // JUNIOR: max 1 per project
    if (user.role === 'JUNIOR') {
      const existingJunior = project.members.find(
        (m) => m.leftAt === null && m.user?.role === 'JUNIOR',
      )
      if (existingJunior) {
        throw new BadRequestException('Project already has an active junior member')
      }

      // JUNIOR: cannot be active on another project simultaneously
      const otherProjectMembership = await this.db.db.query.projectMembers.findFirst({
        where: and(
          eq(projectMembers.userId, userId),
          isNull(projectMembers.leftAt),
        ),
      })
      if (otherProjectMembership) {
        throw new BadRequestException('Junior is already an active member of another project')
      }
    }

    await this.db.db.insert(projectMembers).values({ projectId, userId })
  }

  async removeMember(projectId: string, userId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }

    const activeMember = await this.db.db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        isNull(projectMembers.leftAt),
      ),
    })
    if (!activeMember) throw new NotFoundException('Active member not found in project')

    // Prevent removing last HR or last ACCOUNTANT from project
    const userToRemove = await this.db.db.query.users.findFirst({ where: eq(users.id, userId) })
    if (userToRemove?.role === 'HR' || userToRemove?.role === 'ACCOUNTANT') {
      const project = await this.db.db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        with: { members: { with: { user: true } } },
      }) as ProjectWithRelations | undefined

      if (project) {
        const activeOfRole = project.members.filter(
          (m) => m.leftAt === null && m.user?.role === userToRemove.role,
        )
        if (activeOfRole.length <= 1) {
          throw new BadRequestException(`Cannot remove the last ${userToRemove.role} from a project`)
        }
      }
    }

    await this.db.db
      .update(projectMembers)
      .set({ leftAt: new Date() })
      .where(eq(projectMembers.id, activeMember.id))
  }

  async createFromInterview(interview: Interview & { senior: User | null }, _currentUser: SessionUser) {
    const domain = interview.notesDomain ?? 'Other'

    const [project] = await this.db.db
      .insert(projects)
      .values({
        name: interview.companyName,
        companyName: interview.companyName,
        domain,
        logoUrl: null,
        startDate: new Date(),
        seniorId: interview.seniorId,
        rate: 0,
        currency: 'USDT',
        status: 'ACTIVE',
        techStack: interview.notesTechStack ?? null,
        teamSize: interview.notesTeamSize ?? null,
        benefits: interview.notesBenefits ?? null,
        paymentType: interview.notesPaymentType ?? null,
        salaryReview: interview.notesSalaryReview ?? null,
        corpTech: interview.notesCorpTech ?? null,
        notesGeneral: interview.notesGeneral ?? null,
      })
      .returning()

    if (!project) return project

    // Find all teams where this senior is a member
    const seniorTeamMemberships = await this.db.db.query.teamMembers.findMany({
      where: eq(teamMembers.userId, interview.seniorId),
    })
    const teamIds = seniorTeamMemberships.map((m) => m.teamId)

    if (teamIds.length > 0) {
      // Find all members of those teams with their user roles
      const teammates = await this.db.db.query.teamMembers.findMany({
        where: inArray(teamMembers.teamId, teamIds),
        with: { user: { columns: { id: true, role: true } } },
      })

      const addedUserIds = new Set<string>()
      for (const m of teammates) {
        const u = (m as typeof m & { user: { id: string; role: string } | null }).user
        if (!u) continue
        if (u.role !== 'HR' && u.role !== 'ACCOUNTANT') continue
        if (addedUserIds.has(u.id)) continue
        addedUserIds.add(u.id)
        await this.db.db.insert(projectMembers).values({
          projectId: project.id,
          userId: u.id,
        })
      }
    }

    return project
  }

  private async assertAccess(project: ProjectWithRelations, currentUser: SessionUser) {
    if (currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT') return
    if (currentUser.role === 'SENIOR' && project.seniorId === currentUser.id) return
    if (currentUser.role === 'HR') {
      const seniorIds = await this.getHrSeniorIds(currentUser.id)
      if (project.seniorId !== null && seniorIds.includes(project.seniorId)) return
    }
    if (
      currentUser.role === 'JUNIOR' &&
      project.members.some((m) => m.userId === currentUser.id && m.leftAt === null)
    ) {
      return
    }
    throw new ForbiddenException()
  }
}
