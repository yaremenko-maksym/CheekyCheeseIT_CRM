import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { projectMembers, teamMembers, teams, users, type User } from '../database/schema'

export type UserWithAvailability = User & { hasActiveProject: boolean }

@Injectable()
export class UsersService {
  constructor(private db: DatabaseService) {}

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
    techStack?: string | null
    walletAddress?: string | null
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
        walletAddress: data.walletAddress ?? null,
        ...(data.seniorSharePercent !== undefined && { seniorSharePercent: data.seniorSharePercent }),
        ...(data.monthlySalary != null && { monthlySalary: String(data.monthlySalary) }),
      })
      .returning()

    const created = rows[0]
    if (!created) throw new Error('Failed to create user')

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
      techStack?: string | null | undefined
      walletAddress?: string | null | undefined
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
      techStack: string | null
      walletAddress: string | null
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
    if ('walletAddress' in data) set.walletAddress = data.walletAddress ?? null
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
    data: { telegram?: string | null | undefined; phone?: string | null | undefined; walletAddress?: string | null | undefined },
  ): Promise<User> {
    const set: Partial<{ telegram: string | null; phone: string | null; walletAddress: string | null; updatedAt: Date }> = {
      updatedAt: new Date(),
    }
    if ('telegram' in data) set.telegram = data.telegram ?? null
    if ('phone' in data) set.phone = data.phone ?? null
    if ('walletAddress' in data) set.walletAddress = data.walletAddress ?? null

    const rows = await this.db.db
      .update(users)
      .set(set)
      .where(eq(users.id, id))
      .returning()

    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  updateGoogleId(id: string, googleId: string): Promise<void> {
    return this.db.db
      .update(users)
      .set({ googleId, updatedAt: new Date() })
      .where(eq(users.id, id))
      .then(() => undefined)
  }
}
