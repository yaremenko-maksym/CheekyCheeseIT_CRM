import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { projectMembers, projects, teamMembers, teams, users, type User } from '../database/schema'
import { AuditLogService } from './audit-log.service'
import { UsersAccessService } from './users-access.service'

export interface TeamMemberPreview {
  id: string
  displayName: string
  role: User['role']
  avatar: string | null
}

export type UserWithAvailability = User & { hasActiveProject: boolean }

@Injectable()
export class UsersService {
  constructor(
    private db: DatabaseService,
    private accessService: UsersAccessService,
    private auditLogService: AuditLogService,
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

  async findAll(): Promise<UserWithAvailability[]> {
    const allUsers = await this.db.db.select().from(users).where(ne(users.role, 'ADMIN'))
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

  async findAllIncludingAdmin(): Promise<UserWithAvailability[]> {
    const allUsers = await this.db.db.select().from(users)
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

  async createUser(data: {
    email: string
    displayName: string
    role: 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT'
    telegram?: string | null
    phone?: string | null
    avatar?: string | null
    techStack?: string[] | null
    seniorSharePercent?: number
    monthlySalary?: number | null
    hrIds?: string[]
    accountantId?: string | null
    projectId?: string | null
  }): Promise<User> {
    const existing = await this.findByEmail(data.email)
    if (existing) throw new ConflictException('User with this email already exists')

    const rows = await this.db.db
      .insert(users)
      .values({
        email: data.email,
        displayName: data.displayName,
        role: data.role,
        telegram: data.telegram ?? null,
        phone: data.phone ?? null,
        avatar: data.avatar ?? `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(data.displayName)}`,
        techStack: data.techStack ?? null,
        ...(data.seniorSharePercent !== undefined && { seniorSharePercent: data.seniorSharePercent }),
        ...(data.monthlySalary != null && { monthlySalary: String(data.monthlySalary) }),
      })
      .returning()

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
      displayName?: string
      role?: 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT'
      telegram?: string | null | undefined
      phone?: string | null | undefined
      avatar?: string | null | undefined
      techStack?: string[] | null | undefined
      seniorSharePercent?: number | undefined
      monthlySalary?: number | null | undefined
    },
  ): Promise<User> {
    const set: Partial<{
      displayName: string
      role: 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT'
      telegram: string | null
      phone: string | null
      avatar: string | null
      techStack: string[] | null
      seniorSharePercent: number
      monthlySalary: string | null
      updatedAt: Date
    }> = { updatedAt: new Date() }

    if (data.displayName !== undefined) set.displayName = data.displayName
    if (data.role !== undefined) set.role = data.role
    if ('telegram' in data) set.telegram = data.telegram ?? null
    if ('phone' in data) set.phone = data.phone ?? null
    if ('avatar' in data) set.avatar = data.avatar ?? null
    if ('techStack' in data) set.techStack = data.techStack ?? null
    if (data.seniorSharePercent !== undefined) set.seniorSharePercent = data.seniorSharePercent
    if ('monthlySalary' in data) set.monthlySalary = data.monthlySalary != null ? String(data.monthlySalary) : null

    const rows = await this.db.db
      .update(users)
      .set(set)
      .where(eq(users.id, id))
      .returning()

    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  async deleteUser(id: string): Promise<void> {
    const user = await this.findById(id)
    if (!user) throw new NotFoundException('User not found')

    if (user.role === 'SENIOR') {
      const membership = await this.db.db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.userId, id))
        .then((rows) => rows[0])
      if (membership) {
        await this.db.db.delete(teams).where(eq(teams.id, membership.teamId))
      }
    }

    await this.db.db.delete(users).where(eq(users.id, id))
  }

  async updateProfile(
    id: string,
    data: { displayName?: string; telegram?: string | null; phone?: string | null; techStack?: string[] | null },
  ): Promise<User> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (data.displayName !== undefined) set.displayName = data.displayName
    if ('telegram' in data) set.telegram = data.telegram ?? null
    if ('phone' in data) set.phone = data.phone ?? null
    if ('techStack' in data) set.techStack = data.techStack ?? null

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

  async changeRole(id: string, role: User['role']): Promise<User> {
    const rows = await this.db.db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  async changeSalary(id: string, data: { monthlySalary?: number | null; salaryCurrency?: 'USDT' | 'USD' | 'EUR' | 'UAH'; seniorSharePercent?: number }): Promise<User> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (data.monthlySalary !== undefined) set.monthlySalary = data.monthlySalary != null ? String(data.monthlySalary) : null
    if (data.salaryCurrency !== undefined) set.salaryCurrency = data.salaryCurrency
    if (data.seniorSharePercent !== undefined) set.seniorSharePercent = data.seniorSharePercent
    const rows = await this.db.db.update(users).set(set).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  async setAdminNote(id: string, note: string | null): Promise<User> {
    const rows = await this.db.db.update(users).set({ adminNote: note, updatedAt: new Date() }).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  async archive(id: string): Promise<User> {
    const rows = await this.db.db.update(users).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
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
      const memberships = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(eq(teamMembers.userId, userId))
      if (memberships.length === 0) return []
      const teamIds = memberships.map((m) => m.teamId)
      const seniorsInTeams = await this.db.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(users, eq(teamMembers.userId, users.id))
        .where(and(inArray(teamMembers.teamId, teamIds), eq(users.role, 'SENIOR')))
      seniorIds = Array.from(new Set(seniorsInTeams.map((s) => s.userId)))
    }

    if (seniorIds.length === 0) return []

    // Step 2: Collect team_members (SENIOR + HR + ACCOUNTANT) across those seniors' teams.
    // Teams are linked to senior via team_members (the SENIOR is itself a member).
    const seniorMemberships = await this.db.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.userId, users.id))
      .where(and(inArray(teamMembers.userId, seniorIds), eq(users.role, 'SENIOR')))
    const teamIds = Array.from(new Set(seniorMemberships.map((m) => m.teamId)))

    const memberIds = new Set<string>()
    if (teamIds.length > 0) {
      const tmRows = await this.db.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(inArray(teamMembers.teamId, teamIds))
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
        avatar: users.avatar,
      })
      .from(users)
      .where(inArray(users.id, Array.from(memberIds)))
    return rows
  }

  async buildProfileView(viewer: User, targetId: string) {
    const target = await this.findById(targetId)
    if (!target) throw new NotFoundException('User not found')
    const permissions = await this.accessService.getViewPermissions(viewer, target)

    // Filter user fields based on permissions
    const filteredUser: User = { ...target }
    if (!permissions.fields.salary) {
      filteredUser.monthlySalary = null
    }
    if (!permissions.fields.share) {
      filteredUser.seniorSharePercent = 0
    }
    if (!permissions.fields.techStack) {
      filteredUser.techStack = null
    }
    if (!permissions.fields.requisites) {
      filteredUser.paymentMethod = null
      filteredUser.walletUsdtErc20 = null
      filteredUser.walletUsdtLabel = null
      filteredUser.bankUahRecipient = null
      filteredUser.bankUahIban = null
      filteredUser.bankUahRnokpp = null
      filteredUser.bankUahBankName = null
    }

    const data: Record<string, unknown> = {}
    if (permissions.tabs.includes('overview')) {
      data.overview = {
        techStack: permissions.fields.techStack ? (target.techStack ?? []) : null,
        adminNote: viewer.role === 'ADMIN' ? target.adminNote : null,
      }
    }
    // Other tabs (finance, projects, team, interviews, requisites, audit) — wired in later tasks

    return { user: filteredUser, permissions, data }
  }

  updateGoogleId(id: string, googleId: string): Promise<void> {
    return this.db.db
      .update(users)
      .set({ googleId, updatedAt: new Date() })
      .where(eq(users.id, id))
      .then(() => undefined)
  }
}
